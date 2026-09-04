// Cross-module consistency probes for the release triple, runtime config and
// the release documents that describe them. Every assertion cites the document
// that makes the claim; a failing test means the claim is contradicted by the
// code on the audited commit.
//
//   node --test tools/release/__audit__/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { readManifest, readRepoFile, repoRoot } from "./fixture.mjs";

const manifest = readManifest();
const { marketingVersion, buildNumber } = manifest.versionScheme;
const runtimeConfig = readRepoFile("apps/mobile/src/config/runtimeConfig.ts");
const xcprivacy = readRepoFile("apps/mobile/ios/PickleSensei/PrivacyInfo.xcprivacy");
const releaseOps = readRepoFile("docs/RELEASE_OPERATIONS.md");
const releasePlan = readRepoFile("docs/RELEASE_PLAN_V1.md");
const prelaunch = readRepoFile("docs/PRELAUNCH_CHECKLIST.md");
const dossier = readRepoFile("docs/APP_STORE_SUBMISSION.md");
const distribution = readRepoFile("docs/DISTRIBUTION.md");

function runtimeConst(name) {
  const m = new RegExp(`const ${name}(?::[^=]*)?=\\s*\\n?\\s*('([^']*)'|null);`).exec(
    runtimeConfig,
  );
  assert.ok(m, `${name} not found in runtimeConfig.ts`);
  return m[1] === "null" ? null : m[2];
}

// --- version triple -----------------------------------------------------------

test("apps/mobile/package.json version equals the manifest marketingVersion", () => {
  // docs/devin/playbooks/release-gate.md step 5 and
  // .agents/skills/release-verification/SKILL.md step 4 require agreement;
  // packages/release-ops/src/generateManifest.ts:70 publishes this value as
  // mobileBuild.appVersion in the release record.
  const pkg = JSON.parse(readRepoFile("apps/mobile/package.json"));
  assert.equal(pkg.version, marketingVersion);
});

test("release record mobileBuild.appVersion equals the manifest marketingVersion", () => {
  const r = spawnSync("pnpm", ["-s", "--filter", "@pickle/release-ops", "manifest:generate"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const record = JSON.parse(readRepoFile("datasets/release/manifest.json"));
  assert.equal(record.mobileBuild.appVersion, marketingVersion);
});

test("dossier build number agrees with manifest buildNumber / pbxproj CURRENT_PROJECT_VERSION", () => {
  // APP_STORE_SUBMISSION.md §1 records the build attached to 1.0; the manifest
  // calls itself the single source of truth for the triple
  // (RELEASE_OPERATIONS §1) and its rules say build numbers are never reused.
  const m = /Build (\d+) was validated and attached to version ([\d.]+)/.exec(dossier);
  assert.ok(m, "dossier does not record an attached build");
  assert.equal(m[2], marketingVersion);
  assert.equal(Number(m[1]), buildNumber);
});

test("git tag v<version>-build.<build> exists for the recorded store build (manifest rules.gitTag)", () => {
  const m = /Build (\d+) was validated and attached to version ([\d.]+)/.exec(dossier);
  assert.ok(m);
  const tag = `v${m[2]}-build.${m[1]}`;
  const r = spawnSync("git", ["tag", "-l", tag], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(
    r.stdout.trim(),
    tag,
    `no local tag ${tag}; rule ${manifest.versionScheme.rules.gitTag}`,
  );
});

// --- runtime config vs manifest environments ----------------------------------

test("manifest production apiOrigin reflects the committed runtimeConfig API_BASE_URL", () => {
  // RELEASE_OPERATIONS §2: production is "tbd"/not provisioned and runtimeConfig
  // values are null. The committed config carries a real origin, so the gate
  // (checker L78-93) guards a value the shipped binary does not use.
  const apiBaseUrl = runtimeConst("API_BASE_URL");
  assert.ok(apiBaseUrl, "API_BASE_URL is null; the manifest 'tbd' would be accurate");
  assert.equal(manifest.environments.production.apiOrigin, new URL(apiBaseUrl).origin);
});

test("RELEASE_OPERATIONS §2 'runtimeConfig values are intentionally null' matches the code", () => {
  const claimsNull = /runtimeConfig\.ts` values are intentionally null/.test(releaseOps);
  const allNull = ["API_BASE_URL", "REVENUECAT_IOS_PUBLIC_SDK_KEY", "GOOGLE_IOS_CLIENT_ID"].every(
    (name) => runtimeConst(name) === null,
  );
  assert.ok(!claimsNull || allNull, "doc says null; runtimeConfig.ts ships real values");
});

test("runtimeConfig APP_STORE_ID equals the dossier Apple ID", () => {
  const m = /Apple ID `(\d{6,})` is set in/.exec(dossier);
  assert.ok(m, "dossier Apple ID not found");
  assert.equal(runtimeConst("APP_STORE_ID"), m[1]);
});

// --- privacy disclosure sync --------------------------------------------------

test("RELEASE_OPERATIONS §3 'NSPrivacyCollectedDataTypes empty' matches PrivacyInfo.xcprivacy", () => {
  const claimsEmpty = /NSPrivacyCollectedDataTypes`\s*\n?\s*empty/.test(releaseOps);
  const collected = (xcprivacy.match(/<key>NSPrivacyCollectedDataType<\/key>/g) ?? []).length;
  assert.ok(
    !claimsEmpty || collected === 0,
    `doc says empty; xcprivacy declares ${collected} types`,
  );
});

test("PrivacyInfo.xcprivacy collected types/purposes/linked match dossier §5.2 step 3", () => {
  // APP_STORE_SUBMISSION.md §5 (privacy_disclosure_sync is release-blocking in
  // RELEASE_OPERATIONS §3). Only presence of NSPrivacyAccessedAPITypes is
  // machine-checked (check-ios-distribution.mjs L84-87); this is the missing
  // structural comparison. Dossier-only rows must be attributed to an SDK.
  const PURPOSE = {
    "App Functionality": "AppFunctionality",
    "Product Personalization": "ProductPersonalization",
    Analytics: "Analytics",
    "Third-Party Advertising": "ThirdPartyAdvertising",
  };
  const dossierRows = new Map();
  const table = /\*\*Step 3: per data type\.\*\*[\s\S]*?\n\n([\s\S]*?)\n\n/.exec(dossier);
  assert.ok(table, "dossier step-3 table not found");
  for (const line of table[1].split("\n").slice(2)) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 5) continue;
    const [, type, purposes, linked, covers] = cells;
    dossierRows.set(type.replace(/\s+/g, ""), {
      purposes: new Set(purposes.split(";").map((p) => PURPOSE[p.trim()] ?? p.trim())),
      linked: linked === "Yes",
      sdkDeclared: /SDK|provider|Google Sign-In/i.test(covers),
    });
  }
  assert.ok(dossierRows.size >= 10, `parsed only ${dossierRows.size} dossier rows`);

  const entries = [...xcprivacy.matchAll(/<dict>([\s\S]*?)<\/dict>/g)]
    .map((m) => m[1])
    .filter((d) => d.includes("NSPrivacyCollectedDataType<"));
  const declared = new Map();
  for (const d of entries) {
    const type =
      /NSPrivacyCollectedDataType<\/key>\s*<string>NSPrivacyCollectedDataType(\w+)<\/string>/.exec(
        d,
      )[1];
    const linked = /NSPrivacyCollectedDataTypeLinked<\/key>\s*<true\/>/.test(d);
    const tracking = /NSPrivacyCollectedDataTypeTracking<\/key>\s*<true\/>/.test(d);
    const purposes = new Set(
      [...d.matchAll(/NSPrivacyCollectedDataTypePurpose(\w+)<\/string>/g)].map((m) => m[1]),
    );
    declared.set(type, { linked, tracking, purposes });
  }
  assert.ok(declared.size >= 10, `parsed only ${declared.size} xcprivacy entries`);

  for (const [type, app] of declared) {
    const row = dossierRows.get(type);
    assert.ok(row, `xcprivacy declares ${type} but the dossier does not disclose it`);
    assert.equal(app.tracking, false, `${type} tracking must be false`);
    assert.equal(app.linked, row.linked, `${type} linked-to-identity mismatch`);
    assert.deepEqual(
      [...app.purposes].sort(),
      [...row.purposes].sort(),
      `${type} purposes mismatch`,
    );
  }
  for (const [type, row] of dossierRows) {
    if (!declared.has(type)) {
      assert.ok(
        row.sdkDeclared,
        `dossier discloses ${type} but neither xcprivacy nor an SDK attribution covers it`,
      );
    }
  }
});

test("PrivacyInfo.xcprivacy declares NSPrivacyTracking false (dossier: tracking = No)", () => {
  assert.match(xcprivacy, /<key>NSPrivacyTracking<\/key>\s*<false\/>/);
});

// --- release docs vs shipping code --------------------------------------------

test("RELEASE_PLAN_V1 does not still claim typed-501 receipt validation / no paid features", () => {
  // Billing is live StoreKit via RevenueCat (AGENTS.md → Billing;
  // runtimeConfig appl_ key; edge fn POST /webhooks/revenuecat).
  const stale = /purchase validation returns typed-501/.test(releasePlan);
  const liveBilling = /^const REVENUECAT_IOS_PUBLIC_SDK_KEY[^\n]*\n?\s*'appl_/m.test(runtimeConfig);
  assert.ok(!(stale && liveBilling), "RELEASE_PLAN_V1 §8 still says no paid features may be sold");
});

test("PRELAUNCH_CHECKLIST QA sweep only names screens that exist", () => {
  const m = /Screen-by-screen button sweep:([\s\S]*?)—/.exec(prelaunch);
  assert.ok(m, "sweep list not found");
  const names = m[1]
    .split(",")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const nav = readRepoFile("apps/mobile/src/navigation/RootNavigator.tsx");
  const missing = names.filter((name) => name === "Live Court" && !/LiveCourt/.test(nav));
  assert.deepEqual(missing, [], `checklist names screens with no navigator route: ${missing}`);
});

test("PRELAUNCH_CHECKLIST test-key swap item is not stale for the shipping platform", () => {
  const item = /Swap the RevenueCat TEST key \(`test_…`\) for `appl_…`/.test(prelaunch);
  const iosKey = runtimeConst("REVENUECAT_IOS_PUBLIC_SDK_KEY") ?? "";
  // The item is still open only if iOS (the shipping platform) is on test_.
  assert.ok(
    !item || !iosKey.startsWith("appl_"),
    "iOS already ships appl_; the ☐ swap item is stale",
  );
});

test("DISTRIBUTION.md build history agrees with the dossier's attached build", () => {
  const first = /First upload \(build ([\d.]+)\/(\d+)\)/.exec(distribution);
  const attached = /Build (\d+) was validated and attached to version ([\d.]+)/.exec(dossier);
  assert.ok(first && attached);
  // Same version line; the later document must not describe an earlier build
  // as the current one without recording the later ones.
  assert.equal(first[1], attached[2]);
  assert.ok(
    Number(first[2]) === Number(attached[1]) ||
      new RegExp(`build ${attached[1]}\\b`).test(distribution),
    `DISTRIBUTION.md only records build ${first[2]}; dossier records build ${attached[1]}`,
  );
});

// --- CI wiring ------------------------------------------------------------------

test("release stage runs on every PR (verify-cloud PR_STAGES / ci.yml --only lists)", () => {
  // RELEASE_OPERATIONS §1: "pnpm release:check verifies ..."; the coordinator
  // relies on CI, but the stage is only in the full tier.
  const verify = readRepoFile("scripts/verify-cloud.sh");
  const ci = readRepoFile(".github/workflows/ci.yml");
  const prStages = /^PR_STAGES=\(([^)]*)\)/m.exec(verify);
  assert.ok(prStages);
  const onlyLists = [...ci.matchAll(/--only ([\w,]+)/g)].map((m) => m[1]);
  assert.ok(
    prStages[1].split(/\s+/).includes("release") &&
      onlyLists.some((l) => l.split(",").includes("release")),
    `release not in PR_STAGES (${prStages[1]}) nor in ci.yml --only lists (${onlyLists.join(" | ")})`,
  );
});
