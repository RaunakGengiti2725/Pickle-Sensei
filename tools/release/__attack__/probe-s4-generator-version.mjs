// S4 — `pnpm --filter @pickle/release-ops manifest:generate` vs infra/release/release-manifest.json.
//
//   node tools/release/__attack__/probe-s4-generator-version.mjs [out.json]
//
// Exit 0 = HELD (generated record agrees with the release manifest),
// exit 1 = BROKEN (the two "sources of truth" disagree), exit 2 = generator failed.
// datasets/release/manifest.json is git-ignored, so running the generator leaves
// the working tree clean.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, readManifest } from "./sandbox.mjs";

const out = process.argv[2];
const gen = spawnSync("pnpm", ["--filter", "@pickle/release-ops", "manifest:generate"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
  timeout: 300_000,
});
if (gen.status !== 0) {
  console.error(gen.stdout, gen.stderr);
  console.error(`manifest:generate exit=${gen.status}`);
  process.exit(2);
}

const generated = JSON.parse(
  readFileSync(join(REPO_ROOT, "datasets/release/manifest.json"), "utf8"),
);
const release = readManifest();
const mobilePkg = JSON.parse(readFileSync(join(REPO_ROOT, "apps/mobile/package.json"), "utf8"));

const problems = [];
if (generated.mobileBuild.appVersion !== release.versionScheme.marketingVersion) {
  problems.push(
    `generated mobileBuild.appVersion=${generated.mobileBuild.appVersion} (from apps/mobile/package.json ` +
      `version=${mobilePkg.version}) but release-manifest marketingVersion=${release.versionScheme.marketingVersion}`,
  );
}
if (generated.mobileBuild.buildNumber !== release.versionScheme.buildNumber) {
  problems.push(
    `generated mobileBuild.buildNumber=${generated.mobileBuild.buildNumber} but release-manifest ` +
      `buildNumber=${release.versionScheme.buildNumber}`,
  );
}
// The shipping backend is the Supabase Edge Function; the generator describes services/api + packages/database.
if (!/^\d{14}_/.test(generated.databaseSchema.latestMigration)) {
  problems.push(
    `generated databaseSchema.latestMigration=${generated.databaseSchema.latestMigration} is not a ` +
      "supabase/migrations file (production schema lives in supabase/migrations/YYYYMMDDHHMMSS_*.sql)",
  );
}

const report = {
  scenario: "S4",
  command: "pnpm --filter @pickle/release-ops manifest:generate",
  generatorExit: gen.status,
  generated: {
    commitSha: generated.commitSha,
    mobileBuild: generated.mobileBuild,
    backendRelease: generated.backendRelease,
    databaseSchema: generated.databaseSchema,
  },
  releaseManifest: release.versionScheme,
  mobilePackageVersion: mobilePkg.version,
  problems,
  verdict: problems.length === 0 ? "HELD" : "BROKEN",
};
const text = JSON.stringify(report, null, 2);
console.log(text);
if (out) writeFileSync(out, text + "\n");
process.exit(problems.length === 0 ? 0 : 1);
