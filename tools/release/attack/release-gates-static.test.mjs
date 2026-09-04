/**
 * Static (no-sandbox) probes of the release-config gates at HEAD. Each test asserts a
 * documented release invariant against the committed files; a failure is a gap between what
 * docs/RELEASE_OPERATIONS.md, docs/APP_STORE_SUBMISSION.md, .agents/skills/release-verification
 * and docs/devin/OPERATING_SYSTEM.md promise and what the repo actually enforces. Run:
 *
 *   node --test tools/release/attack/release-gates-static.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FILES, repoRoot } from "./sandbox.mjs";

const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");
const manifest = JSON.parse(read(FILES.manifest));
const dossier = read("docs/APP_STORE_SUBMISSION.md");
const ciYml = read(".github/workflows/ci.yml");
const verifyCloud = read("scripts/verify-cloud.sh");
const releaseChecker = read(FILES.releaseChecker);
const distributionChecker = read(FILES.distributionChecker);
const runtimeConfig = read(FILES.runtimeConfig);

const CANONICAL_APP_STORE_ID = "6806918402";

test("CI (ci.yml) runs the `release` verify-cloud stage on pull requests", () => {
  const onlyLists = [...ciYml.matchAll(/verify-cloud\.sh --only ([\w,]+)/g)].map((m) =>
    m[1].split(","),
  );
  const prStages = verifyCloud.match(/^PR_STAGES=\(([^)]*)\)/m)[1].split(/\s+/);
  const ciRunsRelease = onlyLists.some((list) => list.includes("release"));
  assert.ok(
    ciRunsRelease || prStages.includes("release"),
    `release stage is absent from ci.yml --only lists ${JSON.stringify(onlyLists)} and from PR_STAGES ${JSON.stringify(prStages)}`,
  );
});

test("check:distribution is wired into an automated Linux gate (CI or verify-cloud)", () => {
  const wired = /check:distribution|check-ios-distribution/.test(ciYml + verifyCloud);
  assert.ok(
    wired,
    "docs/RELEASE_OPERATIONS.md §5 lists check:distribution under authorization 'none (automated)' but neither ci.yml nor scripts/verify-cloud.sh invokes it",
  );
});

test("a release gate pins runtimeConfig APP_STORE_ID to the dossier's Apple ID", () => {
  assert.match(
    runtimeConfig,
    new RegExp(`APP_STORE_ID[^\\n]*'${CANONICAL_APP_STORE_ID}'`),
    "runtimeConfig value",
  );
  assert.match(dossier, new RegExp(CANONICAL_APP_STORE_ID), "dossier value");
  assert.ok(
    releaseChecker.includes(CANONICAL_APP_STORE_ID) ||
      distributionChecker.includes(CANONICAL_APP_STORE_ID),
    "neither tools/release/check-release-manifest.mjs nor apps/mobile/scripts/check-ios-distribution.mjs references the Apple ID",
  );
});

test("release checker requires every pbxproj configuration to carry the manifest version/build", () => {
  const pbxproj = read(FILES.pbxproj);
  const buildOccurrences = pbxproj.match(/CURRENT_PROJECT_VERSION = \d+;/g) ?? [];
  const versionOccurrences = pbxproj.match(/MARKETING_VERSION = [\d.]+;/g) ?? [];
  assert.equal(buildOccurrences.length, 2, "expected Debug + Release build settings");
  assert.equal(versionOccurrences.length, 2, "expected Debug + Release marketing versions");
  const usesSubstringIncludes =
    /pbxproj\.includes\(`CURRENT_PROJECT_VERSION = \$\{buildNumber\};`\)/.test(releaseChecker) &&
    /pbxproj\.includes\(`MARKETING_VERSION = \$\{marketingVersion\};`\)/.test(releaseChecker);
  assert.ok(
    !usesSubstringIncludes,
    "checker uses String.includes — one matching configuration satisfies it, so Debug/Release drift is invisible",
  );
});

test("manifest ids are unique across monitoringHooks / rollbackHooks / irreversibleActions", () => {
  for (const key of ["monitoringHooks", "rollbackHooks", "irreversibleActions"]) {
    const ids = manifest[key].map((h) => h.id);
    assert.equal(new Set(ids).size, ids.length, `${key} has duplicate ids at HEAD`);
  }
  assert.match(
    releaseChecker,
    /duplicate|new Set\([^)]*\)\.size/,
    "release checker never asserts id uniqueness (REQUIRED ids are matched via Set.has)",
  );
});

test("version triple agrees with apps/mobile/package.json (release-verification skill step 4)", () => {
  const pkg = JSON.parse(read("apps/mobile/package.json"));
  assert.equal(
    pkg.version,
    manifest.versionScheme.marketingVersion,
    "skill says pbxproj / package.json / manifest / dossier 'must all agree'",
  );
});

test("manifest buildNumber is not behind the latest build the dossier records as validated", () => {
  const validated = [...dossier.matchAll(/Build (\d+) was validated/g)].map((m) => Number(m[1]));
  assert.ok(validated.length > 0, "dossier records a validated build");
  const latest = Math.max(...validated);
  assert.ok(
    manifest.versionScheme.buildNumber >= latest,
    `manifest buildNumber ${manifest.versionScheme.buildNumber} < dossier validated build ${latest}; 'never reused' cannot be enforced from the manifest`,
  );
});

test("APP_STORE_SUBMISSION.md exists at the path the knowledge base and task briefs cite", () => {
  assert.ok(existsSync(join(repoRoot, "docs/APP_STORE_SUBMISSION.md")), "docs/ copy present");
  assert.ok(
    existsSync(join(repoRoot, "APP_STORE_SUBMISSION.md")),
    "root APP_STORE_SUBMISSION.md missing (knowledge note + AGENTS briefs cite the root path)",
  );
});

test("store copy in the dossier ENTER: fields and description obeys the hard copy rules", () => {
  const forbidden =
    /android|google play|guest mode|live court|\bdupr\b|swingvision|pb vision|selkirk|joola|\d{1,3}\s?% accura|most accurate|\bbest\b|#1|as good as a coach|replaces? (a|your) coach/i;
  const lines = dossier.split("\n");
  const enterLines = lines.filter((l) => l.includes("`ENTER:`"));
  const descStart = lines.findIndex((l, i) => i > 600 && l.trim() === "```");
  const descEnd = lines.findIndex((l, i) => i > descStart && l.trim() === "```");
  const description = lines.slice(descStart + 1, descEnd).join("\n");
  const hits = [...enterLines, ...description.split("\n")].filter((l) => forbidden.test(l));
  assert.deepEqual(hits, [], "forbidden store-copy terms found");
  assert.ok(description.length <= 4000, `description ${description.length} chars`);
});

test("App Store keyword field stays within Apple's 100-byte rule", () => {
  const m = dossier.match(/### 11\.3 Keywords[\s\S]*?```\n([^\n]+)\n```/);
  assert.ok(m, "keywords block found");
  assert.ok(Buffer.byteLength(m[1]) <= 100, `keywords ${Buffer.byteLength(m[1])} bytes`);
  assert.ok(
    m[1].split(",").every((k) => k.length > 2),
    "every keyword > 2 chars",
  );
});
