import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot, generateReleaseRecord } from "./generateManifest.js";
import { validateReleaseRecord } from "./releaseRecord.js";

/**
 * CLI: generate the release manifest for the current repo state, validate it,
 * and write it to datasets/release/manifest.json. Exits non-zero when the
 * generated manifest fails its own validation — a broken generator must never
 * emit a manifest.
 *
 *   pnpm --filter @pickle/release-ops manifest:generate
 */
function main(): void {
  const repoRoot = findRepoRoot(process.cwd());
  const record = generateReleaseRecord({ repoRoot });
  const verdict = validateReleaseRecord(record);
  if (!verdict.valid) {
    console.error("generated manifest failed validation:");
    for (const problem of verdict.problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  const outDir = join(repoRoot, "datasets", "release");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "manifest.json");
  writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
  console.log(`release manifest written: ${outPath}`);
  console.log(
    `commit ${record.commitSha.slice(0, 12)} · db ${record.databaseSchema.latestMigration} · ` +
      `${record.modelVersions.length} models · ${Object.keys(record.techniqueAnalysisProfileVersions).length} technique profiles · ` +
      `${Object.keys(record.featureFlags).length} feature flags`,
  );
}

main();
