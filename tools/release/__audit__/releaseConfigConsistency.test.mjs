// Structural audit probes for the release-config-docs subsystem: do the
// manifest, the checker, the shipping mobile config, and the release docs
// (APP_STORE_SUBMISSION.md, RELEASE_OPERATIONS.md, RELEASE_PLAN_V1.md,
// PRELAUNCH_CHECKLIST.md, DISTRIBUTION.md) agree with each other?
//
// Every assertion cites the line(s) that make the claim. A failing test is a
// concrete contradiction at HEAD, not an opinion.
//
// Run: node --test "tools/release/__audit__/*.test.mjs"
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  GRADLE,
  PBXPROJ,
  RUNTIME_CONFIG,
  readManifest,
  readRepo,
  repoRoot,
} from "./checkerHarness.mjs";

const DOSSIER = "docs/APP_STORE_SUBMISSION.md";
const RELEASE_OPS = "docs/RELEASE_OPERATIONS.md";
const RELEASE_PLAN = "docs/RELEASE_PLAN_V1.md";
const PRELAUNCH = "docs/PRELAUNCH_CHECKLIST.md";
const DISTRIBUTION = "docs/DISTRIBUTION.md";
const OPERATING_SYSTEM = "docs/devin/OPERATING_SYSTEM.md";
const XCPRIVACY = "apps/mobile/ios/PickleSensei/PrivacyInfo.xcprivacy";
const MOBILE_PKG = "apps/mobile/package.json";

const manifest = readManifest();
const { marketingVersion, buildNumber } = manifest.versionScheme;
const dossier = readRepo(DOSSIER);
const releaseOps = readRepo(RELEASE_OPS);
const releasePlan = readRepo(RELEASE_PLAN);
const runtimeConfig = readRepo(RUNTIME_CONFIG);

function lineOf(text, needle) {
  const idx = text.indexOf(needle);
  if (idx === -1) throw new Error(`not found: ${JSON.stringify(needle)}`);
  return text.slice(0, idx).split("\n").length;
}

function fencedBlockAfter(text, marker) {
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `marker not found: ${marker}`);
  const open = text.indexOf("```\n", start);
  const close = text.indexOf("\n```", open + 4);
  return text.slice(open + 4, close);
}

function allMatches(text, re) {
  return [...text.matchAll(re)].map((m) => m[1]);
}

// ------------------------------------------------------------ version triple

test("version triple: pbxproj (both configs), gradle, runtimeConfig agree with the manifest", () => {
  const pbx = readRepo(PBXPROJ);
  assert.deepEqual(allMatches(pbx, /MARKETING_VERSION = ([\d.]+);/g), [
    marketingVersion,
    marketingVersion,
  ]);
  assert.deepEqual(allMatches(pbx, /CURRENT_PROJECT_VERSION = (\d+);/g), [
    String(buildNumber),
    String(buildNumber),
  ]);
  const gradle = readRepo(GRADLE);
  assert.deepEqual(allMatches(gradle, /^\s*versionName "([^"]+)"/gm), [marketingVersion]);
  assert.deepEqual(allMatches(gradle, /^\s*versionCode (\d+)/gm), [String(buildNumber)]);
  assert.deepEqual(allMatches(runtimeConfig, /^const APP_VERSION = '([^']+)';/gm), [
    marketingVersion,
  ]);
});

test("version triple: apps/mobile/package.json version equals the manifest marketingVersion (release-verification skill step 4 / release-gate playbook step 5; consumed by packages/release-ops generateManifest.ts:69)", () => {
  const pkg = JSON.parse(readRepo(MOBILE_PKG));
  assert.equal(
    pkg.version,
    marketingVersion,
    `${MOBILE_PKG}:${lineOf(readRepo(MOBILE_PKG), '"version"')} says ${pkg.version}; infra/release/release-manifest.json says ${marketingVersion}`,
  );
});

test("build number: the manifest's single-source-of-truth buildNumber is not behind the build the dossier records as attached to 1.0", () => {
  const m = /Build (\d+) was validated and attached to version ([\d.]+)/.exec(dossier);
  assert.ok(m, "dossier records an attached build");
  const dossierBuild = Number(m[1]);
  assert.equal(m[2], marketingVersion);
  assert.ok(
    buildNumber >= dossierBuild,
    `${DOSSIER}:${lineOf(dossier, m[0])} records build ${dossierBuild} attached to ${m[2]}, but infra/release/release-manifest.json buildNumber=${buildNumber} (and pbxproj/gradle pinned to it). Rule versionScheme.rules.buildNumber: "monotonically increasing ... never reused or reset".`,
  );
});

test("build number: DISTRIBUTION.md records build 1 as already uploaded, so a committed buildNumber of 1 would be a reuse", () => {
  const dist = readRepo(DISTRIBUTION);
  const m = /First upload \(build ([\d.]+)\/(\d+)\) shipped/.exec(dist);
  assert.ok(m, "DISTRIBUTION.md records the first upload");
  const shippedBuild = Number(m[2]);
  assert.ok(
    buildNumber > shippedBuild,
    `${DISTRIBUTION}:${lineOf(dist, m[0])} says build ${m[1]}/${shippedBuild} already shipped; manifest buildNumber=${buildNumber} is not greater (rule: never reused).`,
  );
});

test("version format: a two-component marketingVersion is only acceptable because RELEASE_OPERATIONS §1 documents the pre-release exception", () => {
  const rule = manifest.versionScheme.rules.marketingVersion;
  assert.ok(rule.startsWith("MAJOR.MINOR.PATCH;"));
  const hasPatch = /^\d+\.\d+\.\d+$/.test(marketingVersion);
  const exceptionDocumented = releaseOps.includes(
    "two-component form is accepted for the pre-release line",
  );
  assert.ok(
    hasPatch || exceptionDocumented,
    `marketingVersion "${marketingVersion}" has no PATCH and no documented exception`,
  );
});

test("git tag convention: RELEASE_OPERATIONS/manifest (v<version>-build.<build>) and RELEASE_PLAN_V1 §2 step 1 agree", () => {
  const planTag = /git tag (rc-v[\d.]+)/.exec(releasePlan);
  assert.ok(planTag, "RELEASE_PLAN_V1 names a tag");
  const opsRule = manifest.versionScheme.rules.gitTag;
  assert.match(opsRule, /v<version>-build\.<build>/);
  assert.match(
    planTag[1],
    /^v\d+\.\d+(\.\d+)?-build\.\d+$/,
    `${RELEASE_PLAN}:${lineOf(releasePlan, planTag[0])} freezes the RC with tag "${planTag[1]}" while the manifest rule (and ${RELEASE_OPS} §1) require "v<version>-build.<build>".`,
  );
});

// -------------------------------------------------- environments / runtime

test("environments: the manifest's description of the committed mobile config (development.mobileConfig 'all null') matches runtimeConfig.ts", () => {
  const dev = manifest.environments.development;
  assert.match(dev.mobileConfig, /all null/);
  const apiLine = /^const API_BASE_URL: string \| null =\s*\n?\s*(.+);/m.exec(runtimeConfig);
  assert.ok(apiLine, "runtimeConfig declares API_BASE_URL");
  assert.equal(
    apiLine[1].trim(),
    "null",
    `${RUNTIME_CONFIG}:${lineOf(runtimeConfig, "const API_BASE_URL")} commits ${apiLine[1].trim()} while release-manifest.json environments.development.mobileConfig claims "${dev.mobileConfig}" and environments.production.apiOrigin is "${manifest.environments.production.apiOrigin}" (the checker asserts 'tbd' on the manifest, never on the file that ships).`,
  );
});

test("RELEASE_OPERATIONS §2: 'runtimeConfig.ts values are intentionally null in the repo' matches runtimeConfig.ts", () => {
  const claim = "runtimeConfig.ts` values are intentionally null in\n  the repo";
  const line = lineOf(releaseOps, claim);
  const nonNull = [
    /^const API_BASE_URL: string \| null =\s*\n?\s*'(.+)';/m,
    /^const REVENUECAT_IOS_PUBLIC_SDK_KEY: string \| null =\s*\n?\s*'(.+)';/m,
    /^const GOOGLE_IOS_CLIENT_ID: string \| null =\s*\n?\s*'(.+)';/m,
    /^const APP_STORE_ID: string \| null = '(.+)';/m,
  ].filter((re) => re.test(runtimeConfig));
  assert.equal(
    nonNull.length,
    0,
    `${RELEASE_OPS}:${line} claims the values are null; ${RUNTIME_CONFIG} commits ${nonNull.length} non-null production values (API origin, RevenueCat appl_ key, Google client id, App Store id).`,
  );
});

test("RELEASE_OPERATIONS §2 environment table: 'Mobile build config ... runtimeConfig.ts defaults (all null...)' matches runtimeConfig.ts", () => {
  const row = releaseOps
    .split("\n")
    .find((l) => l.includes("Mobile build config") && l.includes("all null"));
  assert.ok(row, "table row exists");
  assert.ok(
    !/const API_BASE_URL: string \| null =\s*\n?\s*'https:/m.test(runtimeConfig),
    `${RELEASE_OPS}:${lineOf(releaseOps, row)} says the committed defaults are all null, but ${RUNTIME_CONFIG}:${lineOf(runtimeConfig, "'https://")} commits the production API origin.`,
  );
});

// --------------------------------------------------------------- privacy

const XCPRIVACY_TYPE_TO_DOSSIER = {
  NSPrivacyCollectedDataTypeName: "Name",
  NSPrivacyCollectedDataTypeEmailAddress: "Email Address",
  NSPrivacyCollectedDataTypePhoneNumber: "Phone Number",
  NSPrivacyCollectedDataTypeFitness: "Fitness",
  NSPrivacyCollectedDataTypeCoarseLocation: "Coarse Location",
  NSPrivacyCollectedDataTypeOtherUserContent: "Other User Content",
  NSPrivacyCollectedDataTypeBrowsingHistory: "Browsing History",
  NSPrivacyCollectedDataTypeUserID: "User ID",
  NSPrivacyCollectedDataTypeDeviceID: "Device ID",
  NSPrivacyCollectedDataTypePurchaseHistory: "Purchase History",
  NSPrivacyCollectedDataTypeProductInteraction: "Product Interaction",
  NSPrivacyCollectedDataTypeAdvertisingData: "Advertising Data",
  NSPrivacyCollectedDataTypeOtherUsageData: "Other Usage Data",
  NSPrivacyCollectedDataTypeOtherDataTypes: "Other Data Types",
};
const PURPOSE_TO_DOSSIER = {
  NSPrivacyCollectedDataTypePurposeAppFunctionality: "App Functionality",
  NSPrivacyCollectedDataTypePurposeProductPersonalization: "Product Personalization",
  NSPrivacyCollectedDataTypePurposeAnalytics: "Analytics",
  NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising: "Third-Party Advertising",
};
// Dossier §5.2 / Appendix B: these three come from provider SDK manifests
// and are intentionally NOT duplicated in the app-target xcprivacy.
const PROVIDER_ONLY = new Set(["Phone Number", "Coarse Location", "Device ID"]);

function parseXcprivacy() {
  const xml = readRepo(XCPRIVACY);
  const arrStart = xml.indexOf("<key>NSPrivacyCollectedDataTypes</key>");
  const arrEnd = xml.indexOf("<key>NSPrivacyTracking</key>");
  const body = xml.slice(arrStart, arrEnd);
  const entries = [];
  for (const dict of body.split("<dict>").slice(1)) {
    const type = /<key>NSPrivacyCollectedDataType<\/key>\s*<string>([^<]+)<\/string>/.exec(
      dict,
    )?.[1];
    const linked = /<key>NSPrivacyCollectedDataTypeLinked<\/key>\s*<(true|false)\/>/.exec(
      dict,
    )?.[1];
    const tracking = /<key>NSPrivacyCollectedDataTypeTracking<\/key>\s*<(true|false)\/>/.exec(
      dict,
    )?.[1];
    const purposesBlock =
      /<key>NSPrivacyCollectedDataTypePurposes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
        dict,
      )?.[1] ?? "";
    const purposes = allMatches(purposesBlock, /<string>([^<]+)<\/string>/g);
    entries.push({ type, linked, tracking, purposes });
  }
  const trackingFlag = /<key>NSPrivacyTracking<\/key>\s*<(true|false)\/>/.exec(xml)?.[1];
  return { entries, trackingFlag };
}

function parseDossierStep3() {
  const start = dossier.indexOf("**Step 3: per data type.**");
  const end = dossier.indexOf("**Step 4: Publish.**");
  const rows = dossier
    .slice(start, end)
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| Data type") && !l.startsWith("| ---"));
  const out = new Map();
  for (const row of rows) {
    const cells = row.split("|").map((c) => c.trim());
    out.set(cells[1], {
      purposes: cells[2]
        .split(";")
        .map((p) => p.trim())
        .sort(),
      linked: cells[3],
    });
  }
  return out;
}

test("privacy: PrivacyInfo.xcprivacy collected data types == dossier §5.2 step 2/3 minus the provider-declared three; purposes, linked, tracking agree", () => {
  const { entries, trackingFlag } = parseXcprivacy();
  const step3 = parseDossierStep3();
  assert.equal(step3.size, 14, "dossier lists fourteen types");
  const appTypes = entries.map((e) => XCPRIVACY_TYPE_TO_DOSSIER[e.type]);
  const expected = [...step3.keys()].filter((t) => !PROVIDER_ONLY.has(t)).sort();
  assert.deepEqual([...appTypes].sort(), expected);
  for (const e of entries) {
    const name = XCPRIVACY_TYPE_TO_DOSSIER[e.type];
    const row = step3.get(name);
    assert.deepEqual(
      e.purposes.map((p) => PURPOSE_TO_DOSSIER[p]).sort(),
      row.purposes,
      `purposes for ${name}`,
    );
    assert.equal(e.linked, "true", `${name} linked`);
    assert.equal(row.linked, "Yes", `${name} dossier linked`);
    assert.equal(e.tracking, "false", `${name} tracking`);
  }
  assert.equal(trackingFlag, "false");
});

test("RELEASE_OPERATIONS §3: 'NSPrivacyCollectedDataTypes empty' matches PrivacyInfo.xcprivacy", () => {
  const claim = "`NSPrivacyCollectedDataTypes`\n  empty";
  const line = lineOf(releaseOps, claim);
  const { entries } = parseXcprivacy();
  assert.equal(
    entries.length,
    0,
    `${RELEASE_OPS}:${line} claims NSPrivacyCollectedDataTypes is empty; ${XCPRIVACY} declares ${entries.length} collected data types.`,
  );
});

// ------------------------------------------------------------ stale docs

test("RELEASE_PLAN_V1 §5: 'no paid features may be sold in this release' matches the shipping billing config", () => {
  const claim = "no paid\n  features may be sold in this release";
  const line = lineOf(releasePlan, claim);
  const rcKey = /^const REVENUECAT_IOS_PUBLIC_SDK_KEY: string \| null =\s*\n?\s*'(\w+)_/m.exec(
    runtimeConfig,
  )?.[1];
  const dossierSellsPro = dossier.includes("Pickle Sensei Pro unlocks unlimited validated ratings");
  assert.ok(
    !(rcKey === "appl" && dossierSellsPro),
    `${RELEASE_PLAN}:${line} says no paid features are sold, but ${RUNTIME_CONFIG} ships the production RevenueCat key (appl_) and ${DOSSIER}:${lineOf(dossier, "Pickle Sensei Pro unlocks unlimited validated ratings")} sells Pro. The manifest's monitoringHooks cite RELEASE_PLAN_V1 as their source.`,
  );
});

test("PRELAUNCH_CHECKLIST §7: every screen named in the button-sweep list exists in RootNavigator", () => {
  const prelaunch = readRepo(PRELAUNCH);
  const nav = readRepo("apps/mobile/src/navigation/RootNavigator.tsx");
  const screens = new Set(allMatches(nav, /name="([A-Za-z]+)"/g));
  const line = lineOf(prelaunch, "Live Court");
  assert.ok(
    screens.has("LiveCourt"),
    `${PRELAUNCH}:${line} lists "Live Court" as a screen to QA every release; RootNavigator registers no LiveCourt screen (registered: ${[...screens].sort().join(", ")}).`,
  );
});

test("OPERATING_SYSTEM §2: the `release` stage 'checks APP_STORE_SUBMISSION.md coherence' — the checker actually reads the dossier", () => {
  const os = readRepo(OPERATING_SYSTEM);
  const claimLine = lineOf(os, "`APP_STORE_SUBMISSION.md` coherence");
  const checker = readRepo("tools/release/check-release-manifest.mjs");
  const stage = readRepo("scripts/verify-cloud.sh");
  const stageBody = stage.slice(
    stage.indexOf("stage_release()"),
    stage.indexOf("# ----", stage.indexOf("stage_release()")),
  );
  assert.ok(
    checker.includes("APP_STORE_SUBMISSION") || stageBody.includes("APP_STORE_SUBMISSION"),
    `${OPERATING_SYSTEM}:${claimLine} says the release stage checks APP_STORE_SUBMISSION.md coherence; neither tools/release/check-release-manifest.mjs nor stage_release() in scripts/verify-cloud.sh reads it.`,
  );
});

// ---------------------------------------------------------- store copy

const FORBIDDEN =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d{1,3}\s?% accura|\bbest\b|\bmost accurate\b|as good as a coach/i;

function enterValues(text) {
  // `ENTER:` `value` inline cells
  const inline = [...text.matchAll(/`ENTER:` `([^`]+)`/g)].map((m) => ({
    value: m[1],
    line: lineOf(text, m[0]),
  }));
  return inline;
}

test("store copy: no forbidden term in any dossier ENTER: value or §11 fenced block", () => {
  const hits = [];
  for (const { value, line } of enterValues(dossier)) {
    if (FORBIDDEN.test(value)) hits.push(`${DOSSIER}:${line}: ${value}`);
  }
  for (const marker of ["### 11.2 Promotional Text", "### 11.3 Keywords", "### 11.4 Description"]) {
    const block = fencedBlockAfter(dossier, marker);
    block.split("\n").forEach((l, i) => {
      if (FORBIDDEN.test(l)) hits.push(`${DOSSIER} ${marker} +${i + 1}: ${l}`);
    });
  }
  const appendixD = dossier.slice(dossier.indexOf("## Appendix D"));
  fencedBlockAfter(appendixD, "## Appendix D")
    .split("\n")
    .forEach((l, i) => {
      if (FORBIDDEN.test(l)) hits.push(`${DOSSIER} Appendix D +${i + 1}: ${l}`);
    });
  assert.deepEqual(hits, []);
});

function storeCopyBlocks() {
  return {
    promo: fencedBlockAfter(dossier, "### 11.2 Promotional Text").trim(),
    keywords: fencedBlockAfter(dossier, "### 11.3 Keywords").trim(),
    description: fencedBlockAfter(dossier, "### 11.4 Description").trim(),
  };
}

test("store copy: dossier §11 fields fit Apple's limits (170 / 100 bytes / 4000; names ≤30, in-app purchase descriptions ≤45)", () => {
  const { promo, keywords, description } = storeCopyBlocks();
  assert.ok(promo.length <= 170, `promo ${promo.length}`);
  assert.ok(
    Buffer.byteLength(keywords, "utf8") <= 100,
    `keywords ${Buffer.byteLength(keywords, "utf8")} bytes`,
  );
  assert.ok(keywords.split(",").every((k) => k.length > 2 && !k.includes(" ")));
  assert.ok(description.length <= 4000, `description ${description.length}`);
  assert.equal("Pickle Sensei".length, 13);
  assert.equal("Pickleball technique coach".length, 26);
  for (const name of ["Pro Lifetime", "Pro Monthly", "Pro Yearly", "Pickle Sensei Pro"])
    assert.ok(name.length <= 30);
  for (const d of [
    "Unlimited validated ratings, pay once",
    "Unlimited validated ratings, billed monthly",
    "Unlimited validated ratings, billed yearly",
  ]) {
    assert.ok(d.length <= 45, d);
  }
});

test("store copy: the character counts the dossier states (§11.2 164, §11.3 100 bytes, §11.4 3476, §12 table) equal the fenced text", () => {
  const { promo, keywords, description } = storeCopyBlocks();
  assert.equal(promo.length, 164, "§11.2 states 164 chars");
  assert.equal(Buffer.byteLength(keywords, "utf8"), 100, "§11.3 states 100 bytes");
  const stated = Number(/`ENTER:` \((\d+) chars; paste verbatim/.exec(dossier)?.[1]);
  const tableRow = dossier
    .split("\n")
    .find((l) => l.startsWith("| Description ") && l.includes("§11.4"));
  assert.ok(tableRow);
  assert.equal(Number(tableRow.split("|")[4].trim()), stated, "§12 table agrees with §11.4");
  assert.equal(
    description.length,
    stated,
    `${DOSSIER}:${lineOf(dossier, "chars; paste verbatim")} states ${stated} chars but the fenced description is ${description.length} chars (${Buffer.byteLength(description, "utf8")} bytes)`,
  );
});

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "__tests__" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** User-facing string literals in apps/mobile/src: skips comments, import
 *  paths, testID/kebab tokens and the bare Platform.OS tokens. */
function userFacingLiterals() {
  const out = [];
  for (const file of walk(join(repoRoot, "apps/mobile/src"))) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((l, i) => {
      const trimmed = l.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      for (const m of l.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
        const lit = m[2].replace(/\$\{[^}]*\}/g, "");
        if (lit === "android" || lit === "ios") continue;
        if (lit.startsWith("./") || lit.startsWith("../") || lit.startsWith("@")) continue;
        if (!lit.includes(" ") && lit.includes("-")) continue; // testID / token
        out.push({
          file: file.slice(repoRoot.length + 1),
          line: i + 1,
          lit,
          context: lines.slice(Math.max(0, i - 4), i).join("\n"),
        });
      }
    });
  }
  return out;
}

test("store copy (dossier §0 rule 5: no 'best' in any copy): no superlative in user-facing literals — the paywall screenshot is uploaded to App Store Connect (dossier §4 Review Screenshot)", () => {
  const hits = userFacingLiterals()
    .filter(({ lit }) => /\bbest\b|\bmost accurate\b|as good as a coach/i.test(lit))
    .map(({ file, line, lit }) => `${file}:${line}: ${lit}`);
  assert.deepEqual(hits, []);
});

test("store copy (dossier §0 rule 4): Android / Google Play strings in apps/mobile/src are only reachable behind a Platform.OS === 'android' guard", () => {
  const hits = userFacingLiterals()
    .filter(({ lit }) => /android|google play/i.test(lit))
    .filter(({ context }) => !/Platform\.OS === 'android'/.test(context))
    .map(({ file, line, lit }) => `${file}:${line}: ${lit}`);
  assert.deepEqual(hits, []);
});

test("store copy (dossier §0 rule 4): in-app DUPR mentions are the ones dossier §9 knowingly carries ('rename in-app label in a later build if challenged')", () => {
  const hits = userFacingLiterals().filter(({ lit }) => /dupr/i.test(lit));
  assert.ok(hits.length > 0, "in-app DUPR-style estimate exists (dossier §2 L176, §9 L775)");
  assert.ok(dossier.includes('in-app "DUPR-style estimate" label'));
  assert.ok(
    dossier.includes(
      "Keep DUPR out of metadata; rename in-app label in a later build if challenged.",
    ),
  );
  assert.ok(
    hits.every(({ file }) =>
      /progress\/duprEstimate\.ts|components\/PlayerRankCard\.tsx/.test(file),
    ),
    JSON.stringify(hits),
  );
});

test("store copy (dossier §0 rule 4): no 'Live Court' / 'guest mode' / competitor name / accuracy % in user-facing literals", () => {
  const hits = userFacingLiterals()
    .filter(({ lit }) =>
      /live court|guest mode|swingvision|pb vision|selkirk|joola|\d{1,3}\s?% accura/i.test(lit),
    )
    .map(({ file, line, lit }) => `${file}:${line}: ${lit}`);
  assert.deepEqual(hits, []);
});

// ------------------------------------------------ dossier ⇔ code facts

test("dossier §1 identity facts match the code: App Store id, RevenueCat key, support email, team, bundle id, pods", () => {
  assert.ok(runtimeConfig.includes(`const APP_STORE_ID: string | null = '6806918402';`));
  assert.ok(dossier.includes("`6806918402`"));
  const rcKey = /'(appl_[A-Za-z0-9]+)'/.exec(runtimeConfig)?.[1];
  assert.ok(rcKey && dossier.includes(rcKey));
  const legal = readRepo("supabase/functions/api/legal.ts");
  const email = /const SUPPORT_EMAIL = "([^"]+)"/.exec(legal)?.[1];
  assert.ok(email && dossier.includes(`\`${email}\``));
  const pbx = readRepo(PBXPROJ);
  assert.ok(/DEVELOPMENT_TEAM = H26U6W4K6V;/.test(pbx));
  assert.ok(dossier.includes("H26U6W4K6V"));
  assert.ok(/PRODUCT_BUNDLE_IDENTIFIER = com\.picklesensei;/.test(pbx));
  const podfile = readRepo("apps/mobile/ios/Podfile.lock");
  assert.ok(podfile.includes("- RevenueCat (5.87.1)") && dossier.includes("`RevenueCat` 5.87.1"));
  assert.ok(podfile.includes("- GoogleSignIn (9.2.0)") && dossier.includes("GoogleSignIn 9.2.0"));
  const pkg = JSON.parse(readRepo(MOBILE_PKG));
  assert.equal(pkg.dependencies["react-native-purchases"], "^10.8.1");
  const entitlements = readRepo("apps/mobile/ios/PickleSensei/PickleSensei.entitlements");
  assert.ok(
    entitlements.includes("com.apple.developer.applesignin") &&
      !entitlements.includes("aps-environment"),
  );
});

test("manifest: monitoring hook ids are the nine RELEASE_PLAN_V1 §6 signals; all id sets are unique; irreversible rollbacks require human authorization", () => {
  const ids = manifest.monitoringHooks.map((h) => h.id);
  assert.deepEqual(ids, [
    "silent_failure_rate",
    "target_wrong_lock",
    "excess_abstention",
    "envelope_verdict_distribution",
    "crash_free_sessions",
    "pipeline_latency",
    "session_engine_states",
    "consent_ledger_integrity",
    "flag_drift",
  ]);
  for (const s of manifest.releaseBlockingSteps)
    assert.match(s.source, /^docs\/(RELEASE_PLAN_V1|RELEASE_OPERATIONS|DISTRIBUTION)\.md/);
  assert.equal(new Set(ids).size, ids.length);
  const rb = manifest.rollbackHooks.map((h) => h.id);
  assert.equal(new Set(rb).size, rb.length);
  const irr = manifest.irreversibleActions.map((a) => a.id);
  assert.equal(new Set(irr).size, irr.length);
  assert.ok(manifest.rollbackHooks.every((h) => typeof h.requiresHumanAuthorization === "boolean"));
  assert.ok(
    manifest.rollbackHooks
      .filter((h) => ["db_snapshot_restore", "mobile_expedited_resubmission"].includes(h.id))
      .every((h) => h.requiresHumanAuthorization === true),
  );
});

test("CI wiring: the release checker runs only in the full tier (documented), not on PRs", () => {
  const stage = readRepo("scripts/verify-cloud.sh");
  const prStages = /^PR_STAGES=\(([^)]*)\)/m.exec(stage)?.[1].split(/\s+/) ?? [];
  const allStages = /^ALL_STAGES=\(([^)]*)\)/m.exec(stage)?.[1].split(/\s+/) ?? [];
  assert.ok(allStages.includes("release"));
  assert.ok(!prStages.includes("release"));
  const ci = readRepo(".github/workflows/ci.yml");
  assert.ok(!/--only [^\n]*\brelease\b/.test(ci), "ci.yml does not run the release stage");
  const os = readRepo(OPERATING_SYSTEM);
  assert.ok(
    os.includes("`release` (release-manifest"),
    "OPERATING_SYSTEM documents release as full-tier only",
  );
});
