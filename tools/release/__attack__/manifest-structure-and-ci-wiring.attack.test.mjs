/**
 * Adversarial pass 3 — extra probes beyond the assigned scenarios.
 *
 * X1–X6: manifest sections the docs call load-bearing that the checker never
 *        reads (releaseBlockingSteps, schemaVersion, versionScheme.rules,
 *        duplicate hook ids, monitoring alarm text, malformed JSON).
 * X7:    CI wiring — docs/RELEASE_OPERATIONS.md §5 lists the Linux static
 *        checks as "none (automated)" and the manifest's
 *        releaseBlockingSteps.distribution_preconditions requires
 *        `check:distribution` green at the release SHA; .github/workflows/ci.yml
 *        is the only Linux automation at this commit.
 * X8:    version triple grep across every file the docs name.
 *
 * Assertions state the documented promise; a failing test is a finding.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { makeSandbox, repoRoot } from "./lib/sandbox.mjs";

function withSandbox(label, fn) {
  const sb = makeSandbox(label);
  try {
    return fn(sb);
  } finally {
    sb.dispose();
  }
}

test("X1 releaseBlockingSteps deleted entirely → release:check must fail (manifest is the 'single source of truth' for release-blocking steps)", () => {
  withSandbox("x1", (sb) => {
    sb.mutateManifest((m) => {
      delete m.releaseBlockingSteps;
    });
    const rc = sb.releaseCheck();
    assert.notEqual(rc.status, 0, "all four release-blocking steps vanished and the gate is green");
  });
});

test("X2 schemaVersion changed to 99 (unknown schema) → release:check must fail", () => {
  withSandbox("x2", (sb) => {
    sb.mutateManifest((m) => {
      m.schemaVersion = 99;
    });
    assert.notEqual(sb.releaseCheck().status, 0, "unknown schemaVersion accepted");
  });
});

test("X3 versionScheme.rules deleted → release:check must fail (rules text is what humans follow for tags/images)", () => {
  withSandbox("x3", (sb) => {
    sb.mutateManifest((m) => {
      delete m.versionScheme.rules;
    });
    assert.notEqual(sb.releaseCheck().status, 0, "versionScheme.rules removed, gate green");
  });
});

test("X4 duplicate monitoring hook id with a downgraded severity → release:check fails (control: every() covers duplicates)", () => {
  withSandbox("x4", (sb) => {
    sb.mutateManifest((m) => {
      m.monitoringHooks.push({
        id: "silent_failure_rate",
        signal: "dup",
        alarm: "dup",
        severity: "P1",
      });
    });
    const rc = sb.releaseCheck();
    assert.notEqual(rc.status, 0);
    assert.ok(
      rc.failedLabels.some((l) => l.includes("consent integrity and silent-failure lines are P0")),
    );
  });
});

test("X5 monitoring hook alarm text emptied ('') → release:check must fail (typeof string passes an empty alarm)", () => {
  withSandbox("x5", (sb) => {
    sb.mutateManifest((m) => {
      for (const hook of m.monitoringHooks) {
        hook.alarm = "";
        hook.signal = "";
      }
    });
    assert.notEqual(
      sb.releaseCheck().status,
      0,
      "every monitoring line has an empty signal and alarm, gate green",
    );
  });
});

test("X6 malformed manifest variants fail closed: UTF-8 BOM, trailing comma, truncated file", () => {
  const original = readFileSync(join(repoRoot, "infra/release/release-manifest.json"), "utf8");
  const variants = {
    bom: `\uFEFF${original}`,
    trailingComma: original.replace(/\}\s*$/, ",}\n"),
    truncated: original.slice(0, Math.floor(original.length / 2)),
  };
  for (const [name, content] of Object.entries(variants)) {
    withSandbox(`x6-${name}`, (sb) => {
      sb.write("infra/release/release-manifest.json", content);
      const rc = sb.releaseCheck();
      assert.notEqual(rc.status, 0, `variant ${name} exited 0`);
    });
  }
});

test("X7 CI wiring: the PR gate (ci.yml → verify-cloud.sh --only <PR stages>) runs release:check and something runs check:distribution (docs/RELEASE_OPERATIONS.md §5 'none (automated)'; manifest releaseBlockingSteps.distribution_preconditions)", () => {
  const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const verifyCloud = readFileSync(join(repoRoot, "scripts/verify-cloud.sh"), "utf8");
  const mobilePkg = JSON.parse(readFileSync(join(repoRoot, "apps/mobile/package.json"), "utf8"));
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  // Both scripts exist…
  assert.equal(rootPkg.scripts["release:check"], "node tools/release/check-release-manifest.mjs");
  assert.equal(mobilePkg.scripts["check:distribution"], "node scripts/check-ios-distribution.mjs");

  // …ci.yml delegates to verify-cloud.sh with explicit --only stage lists.
  const ciStages = new Set(
    [...ci.matchAll(/verify-cloud\.sh --only ([a-z,]+)/g)].flatMap((m) => m[1].split(",")),
  );
  const prStages = /^PR_STAGES=\(([^)]*)\)/m.exec(verifyCloud)?.[1].split(/\s+/) ?? [];
  assert.ok(ciStages.size > 0, "ci.yml no longer calls verify-cloud.sh --only");
  assert.ok(
    ciStages.has("release") && prStages.includes("release"),
    `ci.yml runs stages [${[...ciStages].join(",")}] and verify-cloud PR_STAGES=[${prStages.join(",")}]: the 'release' stage (node tools/release/check-release-manifest.mjs) is only in --tier full, i.e. the manifest/version-triple gate never runs on a PR`,
  );

  const anyHarnessRunsDistribution = /check:distribution|check-ios-distribution/.test(
    ci + verifyCloud + (mobilePkg.scripts.test ?? ""),
  );
  assert.ok(
    anyHarnessRunsDistribution,
    "neither ci.yml, scripts/verify-cloud.sh nor the mobile `test` script runs `npm run check:distribution` — the human-only distribution pin is manual-only",
  );
});

test("X8 version triple grep: every file the docs name agrees on marketing version 1.0 / build 1", () => {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "infra/release/release-manifest.json"), "utf8"),
  );
  const pbx = readFileSync(
    join(repoRoot, "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj"),
    "utf8",
  );
  const gradle = readFileSync(join(repoRoot, "apps/mobile/android/app/build.gradle"), "utf8");
  const rt = readFileSync(join(repoRoot, "apps/mobile/src/config/runtimeConfig.ts"), "utf8");
  const dossier = readFileSync(join(repoRoot, "docs/APP_STORE_SUBMISSION.md"), "utf8");

  const mv = manifest.versionScheme.marketingVersion;
  const bn = manifest.versionScheme.buildNumber;
  const pbxMarketing = [...pbx.matchAll(/MARKETING_VERSION = ([\d.]+);/g)].map((m) => m[1]);
  const pbxBuild = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => m[1]);
  assert.deepEqual(
    new Set(pbxMarketing),
    new Set([mv]),
    `pbxproj MARKETING_VERSION values: ${pbxMarketing}`,
  );
  assert.deepEqual(
    new Set(pbxBuild),
    new Set([String(bn)]),
    `pbxproj CURRENT_PROJECT_VERSION values: ${pbxBuild}`,
  );
  assert.equal(pbxMarketing.length, 2, "Debug + Release configurations both present");
  assert.match(gradle, new RegExp(`versionName "${mv.replace(/\./g, "\\.")}"`));
  assert.match(gradle, new RegExp(`versionCode ${bn}\\b`));
  assert.ok(rt.includes(`const APP_VERSION = '${mv}';`));
  // The dossier tells the human to ENTER the version in ASC §11.5.
  assert.ok(
    dossier.includes(`| Version                   | \`ENTER:\` \`${mv}\``),
    "APP_STORE_SUBMISSION.md §11.5 version differs from the manifest",
  );
});

test("X9 build number: the dossier's shipped/attached TestFlight build equals manifest.versionScheme.buildNumber (rule: 'MUST equal iOS CURRENT_PROJECT_VERSION … never reused or reset')", () => {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "infra/release/release-manifest.json"), "utf8"),
  );
  const dossier = readFileSync(join(repoRoot, "docs/APP_STORE_SUBMISSION.md"), "utf8");
  const row = dossier.split("\n").find((l) => l.startsWith("| Build number"));
  assert.ok(row, "dossier §1 has a Build number row");
  const attached = /Build (\d+) was validated and attached/.exec(row);
  assert.ok(attached, `dossier Build number row does not state an attached build: ${row}`);
  assert.equal(
    Number(attached[1]),
    manifest.versionScheme.buildNumber,
    `docs/APP_STORE_SUBMISSION.md §1 says build ${attached[1]} is attached to 1.0; infra/release/release-manifest.json says buildNumber ${manifest.versionScheme.buildNumber} and pnpm release:check is green against project.pbxproj CURRENT_PROJECT_VERSION = ${manifest.versionScheme.buildNumber}`,
  );
});
