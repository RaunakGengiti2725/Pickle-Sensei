/**
 * Sandbox helpers for adversarial probes against the Linux release gates.
 *
 * The two gates under test compute their repo/mobile root from their OWN file
 * location (`tools/release/check-release-manifest.mjs` → `../..`;
 * `apps/mobile/scripts/check-ios-distribution.mjs` → `..`). Copying the script
 * plus exactly the files it reads into a temp tree therefore reproduces the
 * gate byte-for-byte without ever touching the working checkout. The probes
 * mutate the COPIES and run the copied script with `node`.
 *
 * Nothing here writes to the repository.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Every file the two gates read, relative to the repo root. */
export const RELEASE_CHECK_INPUTS = [
  "tools/release/check-release-manifest.mjs",
  "infra/release/release-manifest.json",
  "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj",
  "apps/mobile/android/app/build.gradle",
  "apps/mobile/src/config/runtimeConfig.ts",
];

export const DISTRIBUTION_CHECK_INPUTS = [
  "apps/mobile/scripts/check-ios-distribution.mjs",
  "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj",
  "apps/mobile/ios/PickleSensei/Info.plist",
  "apps/mobile/ios/PickleSensei/PrivacyInfo.xcprivacy",
  "apps/mobile/ios/PickleSensei/PickleSensei.entitlements",
  "apps/mobile/ios/Podfile.lock",
  "apps/mobile/ios/fastlane/Fastfile",
  "apps/mobile/ios/fastlane/Appfile",
];

export function makeSandbox(label) {
  const root = mkdtempSync(join(tmpdir(), `ps-release-attack-${label}-`));
  const inputs = new Set([...RELEASE_CHECK_INPUTS, ...DISTRIBUTION_CHECK_INPUTS]);
  for (const rel of inputs) {
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(repoRoot, rel), dest);
  }
  return {
    root,
    read(rel) {
      return readFileSync(join(root, rel), "utf8");
    },
    write(rel, content) {
      writeFileSync(join(root, rel), content);
    },
    readJson(rel) {
      return JSON.parse(readFileSync(join(root, rel), "utf8"));
    },
    writeJson(rel, value) {
      writeFileSync(join(root, rel), `${JSON.stringify(value, null, 2)}\n`);
    },
    mutateManifest(fn) {
      const manifest = JSON.parse(
        readFileSync(join(root, "infra/release/release-manifest.json"), "utf8"),
      );
      const next = fn(manifest) ?? manifest;
      writeFileSync(
        join(root, "infra/release/release-manifest.json"),
        `${JSON.stringify(next, null, 2)}\n`,
      );
    },
    replaceInFile(rel, from, to) {
      const abs = join(root, rel);
      const before = readFileSync(abs, "utf8");
      if (!before.includes(from)) {
        throw new Error(`sandbox.replaceInFile: '${from}' not found in ${rel}`);
      }
      writeFileSync(abs, before.split(from).join(to));
    },
    releaseCheck() {
      return run(root, "tools/release/check-release-manifest.mjs");
    },
    distributionCheck() {
      return run(root, "apps/mobile/scripts/check-ios-distribution.mjs");
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function run(root, script) {
  const result = spawnSync(process.execPath, [join(root, script)], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    status: result.status,
    stdout,
    stderr,
    failedLabels: stdout
      .split("\n")
      .filter((line) => line.startsWith("FAIL "))
      .map((line) => line.slice(5)),
    okLabels: stdout
      .split("\n")
      .filter((line) => line.startsWith("ok   "))
      .map((line) => line.slice(5)),
  };
}

/** Deterministic PRNG (mulberry32) so fuzz cases are reproducible from a seed. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
