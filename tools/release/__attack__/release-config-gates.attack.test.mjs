/**
 * Adversarial pass 3 — subsystem `release-config-docs`, plane: cloud (Linux).
 *
 * Each test mutates a SANDBOX copy of the release-gate inputs (see
 * lib/sandbox.mjs) and runs the real gate scripts unchanged:
 *   - `pnpm release:check`            → tools/release/check-release-manifest.mjs
 *   - `npm run check:distribution`    → apps/mobile/scripts/check-ios-distribution.mjs
 *
 * Every assertion states the behaviour the docs PROMISE
 * (docs/RELEASE_OPERATIONS.md §1–§2, infra/release/release-manifest.json
 * $comment, docs/DISTRIBUTION.md). A failing test is therefore a finding
 * (gate does not enforce what the docs claim), a passing test is a HELD gate.
 * Nothing in the repository is modified; only temp copies are edited.
 *
 * Run: node --test tools/release/__attack__/
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { makeSandbox, repoRoot, seededRandom } from "./lib/sandbox.mjs";

const SUPABASE_ORIGIN_IN_RUNTIME_CONFIG =
  "https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api";

function withSandbox(label, fn) {
  const sb = makeSandbox(label);
  try {
    return fn(sb);
  } finally {
    sb.dispose();
  }
}

test("S0 baseline: unmodified copies pass both gates (sandbox is faithful)", () => {
  withSandbox("baseline", (sb) => {
    const rc = sb.releaseCheck();
    assert.equal(rc.status, 0, rc.stdout + rc.stderr);
    assert.equal(rc.failedLabels.length, 0);
    const dc = sb.distributionCheck();
    assert.equal(dc.status, 0, dc.stdout + dc.stderr);
    assert.equal(dc.failedLabels.length, 0);
  });
});

// ---------------------------------------------------------------------------
// S1 — human-only boundary pin: distribute_external / submit_for_review
// ---------------------------------------------------------------------------
test("S1a distribute_external: true in the beta lane → check:distribution fails", () => {
  withSandbox("s1a", (sb) => {
    sb.replaceInFile(
      "apps/mobile/ios/fastlane/Fastfile",
      "distribute_external: false,",
      "distribute_external: true,",
    );
    const dc = sb.distributionCheck();
    assert.notEqual(dc.status, 0, "gate must fail when external distribution is enabled");
    assert.ok(
      dc.failedLabels.some((l) => l.includes("internal-only distribution")),
      `expected the internal-only label to FAIL, got: ${dc.failedLabels.join(" | ")}`,
    );
  });
});

test("S1b submit_for_review: true in the release lane → check:distribution fails", () => {
  withSandbox("s1b", (sb) => {
    sb.replaceInFile(
      "apps/mobile/ios/fastlane/Fastfile",
      "submit_for_review: false,",
      "submit_for_review: true,",
    );
    const dc = sb.distributionCheck();
    assert.notEqual(dc.status, 0);
    assert.ok(dc.failedLabels.some((l) => l.includes("no auto-submit")));
  });
});

test("S1c the pin is a substring match: `distribute_external: true` in the live call while `distribute_external: false` survives only in a comment → gate must still fail", () => {
  withSandbox("s1c", (sb) => {
    // Attack: flip the real argument, keep the literal the gate greps for in a comment.
    sb.replaceInFile(
      "apps/mobile/ios/fastlane/Fastfile",
      "distribute_external: false, # internal testers only; external needs App Review",
      "distribute_external: true, # was: distribute_external: false",
    );
    const dc = sb.distributionCheck();
    assert.notEqual(
      dc.status,
      0,
      "external distribution is live in the lane but the gate is satisfied by a comment",
    );
  });
});

test("S1d `submit_for_review: true` live + `submit_for_review: false` only in a comment → gate must still fail", () => {
  withSandbox("s1d", (sb) => {
    sb.replaceInFile(
      "apps/mobile/ios/fastlane/Fastfile",
      "submit_for_review: false, # review submission is a human decision",
      "submit_for_review: true, # formerly submit_for_review: false",
    );
    const dc = sb.distributionCheck();
    assert.notEqual(dc.status, 0, "auto-submit is live but the gate is satisfied by a comment");
  });
});

test("S1e a second upload_to_testflight call with distribute_external: true beside the original → gate must fail", () => {
  withSandbox("s1e", (sb) => {
    sb.replaceInFile(
      "apps/mobile/ios/fastlane/Fastfile",
      '  desc "Build and upload the App Store release binary (Mac-only).',
      [
        "  lane :beta_external do",
        "    api_key = asc_api_key",
        '    upload_to_testflight(api_key: api_key, distribute_external: true, groups: ["Everyone"])',
        "  end",
        "",
        '  desc "Build and upload the App Store release binary (Mac-only).',
      ].join("\n"),
    );
    const dc = sb.distributionCheck();
    assert.notEqual(
      dc.status,
      0,
      "a lane that distributes externally exists and the gate is green",
    );
  });
});

// ---------------------------------------------------------------------------
// S2 — development.apiOrigin strict-null check
// ---------------------------------------------------------------------------
test("S2a environments.development.apiOrigin = '' → release:check fails", () => {
  withSandbox("s2a", (sb) => {
    sb.mutateManifest((m) => {
      m.environments.development.apiOrigin = "";
    });
    const rc = sb.releaseCheck();
    assert.notEqual(rc.status, 0);
    assert.ok(rc.failedLabels.some((l) => l.includes("development has no API origin")));
  });
});

test("S2b environments.development.apiOrigin removed (undefined) → release:check fails", () => {
  withSandbox("s2b", (sb) => {
    sb.mutateManifest((m) => {
      delete m.environments.development.apiOrigin;
    });
    const rc = sb.releaseCheck();
    assert.notEqual(rc.status, 0);
  });
});

test("S2c environments.development.apiOrigin = 'null' (string) / 0 / false → release:check fails for each", () => {
  for (const [i, v] of [
    ["null", "null"],
    ["zero", 0],
    ["false", false],
  ].entries()) {
    withSandbox(`s2c-${i}`, (sb) => {
      sb.mutateManifest((m) => {
        m.environments.development.apiOrigin = v[1];
      });
      const rc = sb.releaseCheck();
      assert.notEqual(rc.status, 0, `variant ${v[0]} passed`);
    });
  }
});

// ---------------------------------------------------------------------------
// S3 — production origin already committed in runtimeConfig.ts
// ---------------------------------------------------------------------------
test("S3a environments.production.apiOrigin = committed Supabase origin → release:check fails on the manifest", () => {
  withSandbox("s3a", (sb) => {
    sb.mutateManifest((m) => {
      m.environments.production.apiOrigin = SUPABASE_ORIGIN_IN_RUNTIME_CONFIG;
    });
    const rc = sb.releaseCheck();
    assert.notEqual(rc.status, 0);
    assert.ok(rc.failedLabels.some((l) => l.startsWith("environments: production origin/bucket")));
  });
});

test("S3b docs promise runtimeConfig.ts defaults are null, yet the committed file carries the production origin — no gate reads API_BASE_URL", () => {
  const runtimeConfig = readFileSync(
    join(repoRoot, "apps/mobile/src/config/runtimeConfig.ts"),
    "utf8",
  );
  const checker = readFileSync(join(repoRoot, "tools/release/check-release-manifest.mjs"), "utf8");
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "infra/release/release-manifest.json"), "utf8"),
  );
  const committedOrigin = runtimeConfig.includes(SUPABASE_ORIGIN_IN_RUNTIME_CONFIG);
  const manifestClaimsNullDefaults = /all null/.test(
    manifest.environments.development.mobileConfig,
  );
  const checkerReadsApiBaseUrl = /API_BASE_URL|apiBaseUrl|apiOrigin.*runtimeConfig/.test(checker);
  // The docs' invariant: manifest.environments.*.apiOrigin and runtimeConfig
  // API_BASE_URL describe the same thing. Either both are null/tbd, or the
  // gate ties them together. Neither holds today.
  assert.ok(
    !committedOrigin || !manifestClaimsNullDefaults || checkerReadsApiBaseUrl,
    "runtimeConfig.ts has the production origin, the manifest says defaults are 'all null', and check-release-manifest.mjs never reads API_BASE_URL",
  );
});

// ---------------------------------------------------------------------------
// S4 — realUserData type confusion
// ---------------------------------------------------------------------------
test("S4a environments.staging.realUserData = 'false' (string) → release:check fails", () => {
  withSandbox("s4a", (sb) => {
    sb.mutateManifest((m) => {
      m.environments.staging.realUserData = "false";
    });
    const rc = sb.releaseCheck();
    assert.notEqual(rc.status, 0);
    assert.ok(rc.failedLabels.some((l) => l.includes("only production carries real user data")));
  });
});

test("S4b environments.production.realUserData = 'true' (string) / 1 → release:check fails for each", () => {
  for (const [i, v] of ["true", 1].entries()) {
    withSandbox(`s4b-${i}`, (sb) => {
      sb.mutateManifest((m) => {
        m.environments.production.realUserData = v;
      });
      const rc = sb.releaseCheck();
      assert.notEqual(rc.status, 0, `variant ${JSON.stringify(v)} passed`);
    });
  }
});

test("S4c environments.development.realUserData = true → release:check fails", () => {
  withSandbox("s4c", (sb) => {
    sb.mutateManifest((m) => {
      m.environments.development.realUserData = true;
    });
    assert.notEqual(sb.releaseCheck().status, 0);
  });
});

// ---------------------------------------------------------------------------
// S5 — version triple drift
// ---------------------------------------------------------------------------
test("S5a marketingVersion '1.0.0' in the manifest only → pbxproj, gradle and APP_VERSION checks all fail", () => {
  withSandbox("s5a", (sb) => {
    sb.mutateManifest((m) => {
      m.versionScheme.marketingVersion = "1.0.0";
    });
    const rc = sb.releaseCheck();
    assert.notEqual(rc.status, 0);
    const failed = rc.failedLabels.join("\n");
    assert.match(failed, /pbxproj: MARKETING_VERSION = 1\.0\.0/);
    assert.match(failed, /build\.gradle: versionName "1\.0\.0"/);
    assert.match(failed, /runtimeConfig\.ts: APP_VERSION = '1\.0\.0'/);
    assert.equal(rc.failedLabels.length, 3, failed);
  });
});

test("S5b APP_VERSION '1.0.0' in runtimeConfig.ts only (manifest/pbxproj/gradle stay 1.0) → release:check fails", () => {
  withSandbox("s5b", (sb) => {
    sb.replaceInFile(
      "apps/mobile/src/config/runtimeConfig.ts",
      "const APP_VERSION = '1.0';",
      "const APP_VERSION = '1.0.0';",
    );
    const rc = sb.releaseCheck();
    assert.notEqual(rc.status, 0);
    assert.ok(rc.failedLabels.some((l) => l.startsWith("runtimeConfig.ts: APP_VERSION")));
  });
});

test("S5c only the Release configuration of project.pbxproj bumps MARKETING_VERSION (Debug keeps 1.0) → release:check must fail", () => {
  withSandbox("s5c", (sb) => {
    const rel = "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj";
    const pbx = sb.read(rel);
    const occurrences = pbx.split("MARKETING_VERSION = 1.0;").length - 1;
    assert.equal(occurrences, 2, "precondition: Debug + Release both carry 1.0");
    // Bump the LAST occurrence (Release build configuration) only.
    const idx = pbx.lastIndexOf("MARKETING_VERSION = 1.0;");
    const mutated =
      pbx.slice(0, idx) +
      "MARKETING_VERSION = 1.1;" +
      pbx.slice(idx + "MARKETING_VERSION = 1.0;".length);
    sb.write(rel, mutated);
    const rc = sb.releaseCheck();
    assert.notEqual(
      rc.status,
      0,
      "Release config ships 1.1 while manifest/APP_VERSION say 1.0 — gate is green because Debug still matches",
    );
  });
});

test("S5d only the Release configuration of project.pbxproj bumps CURRENT_PROJECT_VERSION (Debug keeps 1) → release:check must fail", () => {
  withSandbox("s5d", (sb) => {
    const rel = "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj";
    const pbx = sb.read(rel);
    const needle = "CURRENT_PROJECT_VERSION = 1;";
    assert.equal(pbx.split(needle).length - 1, 2, "precondition: Debug + Release both carry 1");
    const idx = pbx.lastIndexOf(needle);
    sb.write(
      rel,
      pbx.slice(0, idx) + "CURRENT_PROJECT_VERSION = 7;" + pbx.slice(idx + needle.length),
    );
    const rc = sb.releaseCheck();
    assert.notEqual(rc.status, 0, "Release build number 7 ≠ manifest 1 but gate is green");
  });
});

test("S5e buildNumber drift: manifest buildNumber 2 with mobile projects at 1 → release:check fails on pbxproj and gradle", () => {
  withSandbox("s5e", (sb) => {
    sb.mutateManifest((m) => {
      m.versionScheme.buildNumber = 2;
    });
    const rc = sb.releaseCheck();
    assert.notEqual(rc.status, 0);
    const failed = rc.failedLabels.join("\n");
    assert.match(failed, /pbxproj: CURRENT_PROJECT_VERSION = 2/);
    assert.match(failed, /build\.gradle: versionCode 2/);
  });
});

test("S5f seeded fuzz: random semver-ish marketingVersion strings never pass when the mobile projects stay at 1.0", () => {
  const seed = 0x5e1ea5e;
  const rnd = seededRandom(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const candidates = [];
  for (let i = 0; i < 12; i += 1) {
    const major = pick(["0", "1", "2", "10"]);
    const minor = pick(["0", "1", "00", "9"]);
    const patch = pick([null, "0", "1", "10"]);
    const v = patch === null ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
    if (v !== "1.0") candidates.push(v);
  }
  for (const v of candidates) {
    withSandbox(`s5f-${v.replace(/\./g, "_")}`, (sb) => {
      sb.mutateManifest((m) => {
        m.versionScheme.marketingVersion = v;
      });
      const rc = sb.releaseCheck();
      assert.notEqual(rc.status, 0, `seed ${seed}: marketingVersion ${v} passed`);
    });
  }
});

// ---------------------------------------------------------------------------
// S6 — rollback hook authorization flag
// ---------------------------------------------------------------------------
test("S6a rollbackHooks[db_snapshot_restore].requiresHumanAuthorization = false → release:check must fail (manifest $comment: every irreversible action requires a human GO)", () => {
  withSandbox("s6a", (sb) => {
    sb.mutateManifest((m) => {
      const hook = m.rollbackHooks.find((h) => h.id === "db_snapshot_restore");
      hook.requiresHumanAuthorization = false;
    });
    const rc = sb.releaseCheck();
    assert.notEqual(
      rc.status,
      0,
      "db_snapshot_restore (LAST RESORT, consent-integrity risk) is now marked as not needing human authorization and the gate is green",
    );
  });
});

test("S6b every rollbackHook flipped to requiresHumanAuthorization=false → release:check must fail", () => {
  withSandbox("s6b", (sb) => {
    sb.mutateManifest((m) => {
      for (const hook of m.rollbackHooks) hook.requiresHumanAuthorization = false;
    });
    const rc = sb.releaseCheck();
    assert.notEqual(rc.status, 0, "all six irreversible rollback hooks de-authorized, gate green");
  });
});

test("S6c irreversibleActions[production_snapshot_restore].requiresHumanAuthorization = false → release:check fails (control: the sibling list IS enforced)", () => {
  withSandbox("s6c", (sb) => {
    sb.mutateManifest((m) => {
      m.irreversibleActions.find(
        (a) => a.id === "production_snapshot_restore",
      ).requiresHumanAuthorization = false;
    });
    const rc = sb.releaseCheck();
    assert.notEqual(rc.status, 0);
    assert.ok(rc.failedLabels.some((l) => l.includes("production_snapshot_restore")));
  });
});

test("S6d irreversibleActions entry deleted (enable_distribute_external_flag) → release:check must fail (only non-empty is asserted today)", () => {
  withSandbox("s6d", (sb) => {
    sb.mutateManifest((m) => {
      m.irreversibleActions = m.irreversibleActions.filter(
        (a) => a.id !== "enable_distribute_external_flag",
      );
    });
    const rc = sb.releaseCheck();
    assert.notEqual(
      rc.status,
      0,
      "an irreversible action vanished from the manifest and the gate is green",
    );
  });
});

// ---------------------------------------------------------------------------
// S7 — runtimeConfig API_BASE_URL = null: no Linux gate ties origin to manifest
// ---------------------------------------------------------------------------
test("S7a runtimeConfig.ts API_BASE_URL = null → at least one Linux gate (release:check or check:distribution) must fail (a store build with no backend origin cannot sign in)", () => {
  withSandbox("s7a", (sb) => {
    sb.replaceInFile(
      "apps/mobile/src/config/runtimeConfig.ts",
      `const API_BASE_URL: string | null =\n  '${SUPABASE_ORIGIN_IN_RUNTIME_CONFIG}';`,
      "const API_BASE_URL: string | null = null;",
    );
    const rc = sb.releaseCheck();
    const dc = sb.distributionCheck();
    assert.ok(
      rc.status !== 0 || dc.status !== 0,
      `release:check exit ${rc.status}, check:distribution exit ${dc.status}: no Linux gate ties the production origin to the manifest environments`,
    );
  });
});

test("S7c runtimeConfig.ts API_BASE_URL pointed at an attacker origin → at least one Linux gate must fail (origin is unpinned)", () => {
  withSandbox("s7c", (sb) => {
    sb.replaceInFile(
      "apps/mobile/src/config/runtimeConfig.ts",
      `'${SUPABASE_ORIGIN_IN_RUNTIME_CONFIG}'`,
      "'https://attacker.example.invalid/functions/v1/api'",
    );
    const rc = sb.releaseCheck();
    const dc = sb.distributionCheck();
    assert.ok(
      rc.status !== 0 || dc.status !== 0,
      `release:check exit ${rc.status}, check:distribution exit ${dc.status}: a foreign backend origin passes both Linux gates`,
    );
  });
});

test("S7b no Linux gate asserts a release build has its backend origin, RevenueCat key, Google client IDs or App Store id configured", () => {
  const checker = readFileSync(join(repoRoot, "tools/release/check-release-manifest.mjs"), "utf8");
  const dist = readFileSync(
    join(repoRoot, "apps/mobile/scripts/check-ios-distribution.mjs"),
    "utf8",
  );
  const combined = checker + dist;
  const referenced = [
    "API_BASE_URL",
    "REVENUECAT_IOS_PUBLIC_SDK_KEY",
    "GOOGLE_IOS_CLIENT_ID",
    "GOOGLE_WEB_CLIENT_ID",
    "APP_STORE_ID",
  ].filter((name) => combined.includes(name));
  assert.deepEqual(
    referenced,
    [
      "API_BASE_URL",
      "REVENUECAT_IOS_PUBLIC_SDK_KEY",
      "GOOGLE_IOS_CLIENT_ID",
      "GOOGLE_WEB_CLIENT_ID",
      "APP_STORE_ID",
    ],
    `gates reference only: ${JSON.stringify(referenced)}`,
  );
});
