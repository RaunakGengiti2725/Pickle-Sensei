// Structural audit probe (release-config-docs): the generated release record
// is supposed to be "deterministic from single sources of truth"; the release
// manifest (infra/release/release-manifest.json) declares itself the single
// source of truth for the version triple. The two must agree, otherwise the
// RC record that the GO/NO-GO decision consumes carries a version nobody ships.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot, generateReleaseRecord } from "../src/generateManifest.js";

const repoRoot = findRepoRoot(process.cwd());
const manifest = JSON.parse(
  readFileSync(join(repoRoot, "infra/release/release-manifest.json"), "utf8"),
) as { versionScheme: { marketingVersion: string; buildNumber: number } };

describe("release record ⇔ release manifest version triple", () => {
  const record = generateReleaseRecord({ repoRoot });

  it("mobileBuild.appVersion equals release-manifest marketingVersion", () => {
    expect(record.mobileBuild.appVersion).toBe(manifest.versionScheme.marketingVersion);
  });

  it("mobileBuild.buildNumber equals release-manifest buildNumber (not null)", () => {
    expect(record.mobileBuild.buildNumber).toBe(manifest.versionScheme.buildNumber);
  });
});
