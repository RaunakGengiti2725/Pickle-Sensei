#!/usr/bin/env node
/**
 * Adversarial harness — subsystem `mobile-ios-config` (attack pass #4).
 *
 * Every scenario mutates the iOS project / runtime config the way a careless
 * commit would, then runs the Linux gates that are supposed to notice
 * (`npm run check:distribution`, the two compliance/security jest suites,
 * `tools/release/check-release-manifest.mjs`, `tsc`) and records whether they
 * did. The mutations happen in a throw-away `git worktree` of HEAD (never in
 * the caller's checkout) with node_modules symlinked in, so production files
 * are never touched and the run is repeatable on any commit.
 *
 * Usage:
 *   node tools/attack/mobile-ios-config-4/harness.mjs [--only S1,S3] [--out DIR]
 *
 * Exit code: 0 when every gate that MUST catch a mutation caught it, 1 when at
 * least one expected protection did not fire (a finding). Documented,
 * pre-existing gaps (scenarios whose classification is `GAP`) are reported in
 * summary.json but only fail the run when `--strict` is passed.
 *
 * Artifacts: <out>/summary.json + one <out>/<scenario>/<step>.log per command.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? "");
}
const only = flag("--only")?.split(",").filter(Boolean) ?? null;
const strict = args.includes("--strict");
const outDir =
  flag("--out") ??
  join(
    repoRoot,
    "artifacts",
    "attack",
    "mobile-ios-config-4",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
mkdirSync(outDir, { recursive: true });

const headSha = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).stdout.trim();

// ─── throw-away worktree ──────────────────────────────────────────────────────
const wt = mkdtempSync(join(tmpdir(), "pickle-attack-ios-config-"));
rmSync(wt, { recursive: true, force: true });
const add = spawnSync("git", ["worktree", "add", "--detach", wt, "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (add.status !== 0) {
  console.error(add.stderr);
  process.exit(2);
}
for (const rel of ["node_modules", "apps/mobile/node_modules"]) {
  const target = join(repoRoot, rel);
  if (existsSync(target)) symlinkSync(target, join(wt, rel), "dir");
}
const mobile = join(wt, "apps", "mobile");
// The runtime attack suites (S4/S5/S9) ship next to this harness; when the
// caller's checkout has them uncommitted (attack branch not yet created) the
// HEAD worktree lacks them, so mirror the caller's copies in.
const attackSuitesRel = join("apps", "mobile", "__tests__", "attack");
if (existsSync(join(repoRoot, attackSuitesRel))) {
  mkdirSync(join(wt, attackSuitesRel), { recursive: true });
  for (const entry of readdirSync(join(repoRoot, attackSuitesRel))) {
    if (!/^iosConfig4\..*\.test\.tsx?$/.test(entry)) continue;
    copyFileSync(join(repoRoot, attackSuitesRel, entry), join(wt, attackSuitesRel, entry));
  }
}

function cleanup() {
  spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: repoRoot });
  spawnSync("git", ["worktree", "prune"], { cwd: repoRoot });
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

// ─── helpers ─────────────────────────────────────────────────────────────────
const P = {
  entitlements: "apps/mobile/ios/PickleSensei/PickleSensei.entitlements",
  infoPlist: "apps/mobile/ios/PickleSensei/Info.plist",
  pbxproj: "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj",
  appJson: "apps/mobile/app.json",
  appDelegate: "apps/mobile/ios/PickleSensei/AppDelegate.swift",
  runtimeConfig: "apps/mobile/src/config/runtimeConfig.ts",
  manifest: "infra/release/release-manifest.json",
  buildGradle: "apps/mobile/android/app/build.gradle",
};

function wtRead(rel) {
  return readFileSync(join(wt, rel), "utf8");
}

/** Mutate a worktree file; returns a restore() closure. */
function mutate(rel, transform) {
  const abs = join(wt, rel);
  const original = readFileSync(abs, "utf8");
  const next = transform(original);
  if (next === original) {
    throw new Error(`mutation of ${rel} produced no change — attack is void`);
  }
  writeFileSync(abs, next);
  return () => writeFileSync(abs, original);
}

function withMutations(mutations, body) {
  const restores = mutations.map(([rel, fn]) => mutate(rel, fn));
  try {
    return body();
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

const COMMANDS = {
  distribution: {
    label: "npm run check:distribution",
    cwd: mobile,
    cmd: "npm",
    argv: ["run", "-s", "check:distribution"],
  },
  compliance: {
    label: "npx jest --ci --silent __tests__/wf/flow-app-store-compliance-ios-config.test.ts",
    cwd: mobile,
    cmd: "npx",
    argv: ["jest", "--ci", "--silent", "__tests__/wf/flow-app-store-compliance-ios-config.test.ts"],
  },
  security: {
    label: "npx jest --ci --silent __tests__/wf/be-mobile-security-secrets.test.ts",
    cwd: mobile,
    cmd: "npx",
    argv: ["jest", "--ci", "--silent", "__tests__/wf/be-mobile-security-secrets.test.ts"],
  },
  releaseManifest: {
    label: "node tools/release/check-release-manifest.mjs",
    cwd: wt,
    cmd: "node",
    argv: ["tools/release/check-release-manifest.mjs"],
  },
  tsc: {
    label: "npx tsc --noEmit",
    cwd: mobile,
    cmd: "npx",
    argv: ["tsc", "--noEmit"],
  },
  attackS4: {
    label: "npx jest --ci --verbose __tests__/attack/iosConfig4.entryHermesAbsent.test.ts",
    cwd: mobile,
    cmd: "npx",
    argv: ["jest", "--ci", "--verbose", "__tests__/attack/iosConfig4.entryHermesAbsent.test.ts"],
  },
  attackS5: {
    label: "npx jest --ci --verbose __tests__/attack/iosConfig4.settingsNullApiBase.test.tsx",
    cwd: mobile,
    cmd: "npx",
    argv: ["jest", "--ci", "--verbose", "__tests__/attack/iosConfig4.settingsNullApiBase.test.tsx"],
  },
  attackS9: {
    label: "npx jest --ci --verbose __tests__/attack/iosConfig4.reviewAppStateInterleave.test.ts",
    cwd: mobile,
    cmd: "npx",
    argv: [
      "jest",
      "--ci",
      "--verbose",
      "__tests__/attack/iosConfig4.reviewAppStateInterleave.test.ts",
    ],
  },
};

let currentScenario = "baseline";
function run(key, stepName) {
  const spec = COMMANDS[key];
  const started = Date.now();
  const res = spawnSync(spec.cmd, spec.argv, {
    cwd: spec.cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const dir = join(outDir, currentScenario);
  mkdirSync(dir, { recursive: true });
  const logRel = relative(repoRoot, join(dir, `${stepName}.log`));
  writeFileSync(
    join(dir, `${stepName}.log`),
    `$ (cd ${relative(wt, spec.cwd) || "."} && ${spec.label})\n# exit=${res.status}\n\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}\n`,
  );
  return {
    step: stepName,
    command: spec.label,
    cwd: relative(wt, spec.cwd) || ".",
    exit: res.status,
    ms: Date.now() - started,
    stdout: res.stdout,
    stderr: res.stderr,
    log: logRel,
  };
}

/** Lines of check-ios-distribution output ("ok  ..." / "FAIL ...") */
function distributionLines(stdout) {
  return stdout
    .split("\n")
    .filter((l) => /^(ok  |FAIL)/.test(l))
    .map((l) => l.trim());
}

const summary = {
  attackPass: "mobile-ios-config-4",
  head: headSha,
  worktree: "throw-away git worktree of HEAD (removed on exit)",
  startedAt: new Date().toISOString(),
  scenarios: [],
};

function record(scenario) {
  summary.scenarios.push(scenario);
  const tag = scenario.classification.padEnd(6);
  console.log(`\n[${scenario.id}] ${tag} ${scenario.title}`);
  for (const s of scenario.steps) {
    console.log(
      `   ${s.expectation === "must_fail" ? (s.exit !== 0 ? "ok  " : "MISS") : s.expectation === "must_pass" ? (s.exit === 0 ? "ok  " : "MISS") : "info"} exit=${s.exit} ${s.command}`,
    );
  }
  for (const note of scenario.notes) console.log(`   - ${note}`);
}

/**
 * expectation: 'must_fail' (gate must reject the mutation), 'must_pass'
 * (gate is expected to stay green — a documented gap), 'observe'.
 */
function step(result, expectation) {
  return { ...result, stdout: undefined, stderr: undefined, expectation };
}

function classify(steps, gapExpected) {
  const misses = steps.filter(
    (s) =>
      (s.expectation === "must_fail" && s.exit === 0) ||
      (s.expectation === "must_pass" && s.exit !== 0),
  );
  if (misses.length > 0) return "BROKEN";
  return gapExpected ? "GAP" : "HELD";
}

// ─── baseline ────────────────────────────────────────────────────────────────
const baseline = {};
if (!only) {
  currentScenario = "baseline";
  for (const key of ["distribution", "compliance", "security", "releaseManifest"]) {
    baseline[key] = run(key, key);
  }
  summary.baseline = Object.fromEntries(
    Object.entries(baseline).map(([k, v]) => [k, { exit: v.exit, log: v.log }]),
  );
  if (Object.values(baseline).some((r) => r.exit !== 0)) {
    console.error("baseline gates are not green on HEAD — aborting attack run");
    writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    process.exit(2);
  }
  console.log(`baseline on ${headSha.slice(0, 8)}: all four Linux gates exit 0`);
}
function baselineDistributionLines() {
  const r = baseline.distribution ?? run("distribution", "baseline-distribution");
  return distributionLines(r.stdout);
}

// ─── scenarios ───────────────────────────────────────────────────────────────
const scenarios = {
  S1() {
    currentScenario = "S1-entitlement-removed";
    const steps = [];
    const notes = [];
    withMutations(
      [
        [
          P.entitlements,
          (t) =>
            t.replace(
              /\s*<key>com\.apple\.developer\.applesignin<\/key>\s*<array>[\s\S]*?<\/array>/,
              "",
            ),
        ],
      ],
      () => {
        if (wtRead(P.entitlements).includes("applesignin")) {
          throw new Error("entitlement removal mutation failed");
        }
        steps.push(step(run("distribution", "check-distribution"), "must_fail"));
        steps.push(step(run("compliance", "jest-compliance"), "must_fail"));
        steps.push(step(run("security", "jest-security"), "must_fail"));
      },
    );
    // Variant: key kept, capability list emptied (`<array/>`). The plist is
    // still "declaring" the key but grants nothing.
    currentScenario = "S1b-entitlement-empty-array";
    withMutations(
      [
        [
          P.entitlements,
          (t) =>
            t.replace(
              /(<key>com\.apple\.developer\.applesignin<\/key>\s*)<array>[\s\S]*?<\/array>/,
              "$1<array/>",
            ),
        ],
      ],
      () => {
        const d = run("distribution", "check-distribution");
        steps.push(step(d, "observe"));
        steps.push(step(run("compliance", "jest-compliance"), "must_fail"));
        steps.push(step(run("security", "jest-security"), "must_fail"));
        if (d.exit === 0) {
          notes.push(
            "check:distribution only greps for the key name (check-ios-distribution.mjs:91-92) and stays green with an EMPTY applesignin array; both jest suites require <string>Default</string> and fail — depth is in jest, not the npm gate.",
          );
        }
      },
    );
    // Variant: entitlements wired into Debug only (Release loses the file).
    currentScenario = "S1c-entitlements-unwired-release";
    withMutations(
      [
        [
          P.pbxproj,
          (t) => {
            const marker = "CODE_SIGN_ENTITLEMENTS = PickleSensei/PickleSensei.entitlements;";
            const first = t.indexOf(marker);
            const second = t.indexOf(marker, first + 1);
            if (second === -1) throw new Error("expected two CODE_SIGN_ENTITLEMENTS");
            return t.slice(0, second) + t.slice(second + marker.length);
          },
        ],
      ],
      () => {
        const d = run("distribution", "check-distribution");
        steps.push(step(d, "observe"));
        steps.push(step(run("compliance", "jest-compliance"), "must_fail"));
        if (d.exit === 0) {
          notes.push(
            "check:distribution accepts CODE_SIGN_ENTITLEMENTS present in ONE build configuration (regex .test, check-ios-distribution.mjs:50-53); the compliance suite requires >= 2 and fails.",
          );
        }
      },
    );
    return {
      id: "S1",
      title:
        "Remove com.apple.developer.applesignin → check:distribution + both compliance suites must fail",
      steps,
      notes,
      classification: classify(steps, false),
    };
  },

  S2() {
    currentScenario = "S2-appjson-name-mismatch";
    const steps = [];
    const notes = [];
    const moduleName = /withModuleName:\s*"([^"]+)"/.exec(wtRead(P.appDelegate))?.[1];
    notes.push(`AppDelegate.swift startReactNative(withModuleName: "${moduleName}")`);
    withMutations(
      [[P.appJson, (t) => t.replace(/"name":\s*"PickleSensei"/, '"name": "PickleSenseiApp"')]],
      () => {
        const appJson = JSON.parse(wtRead(P.appJson));
        notes.push(
          `app.json name after mutation: "${appJson.name}" (index.js registers this name via AppRegistry.registerComponent)`,
        );
        steps.push(step(run("security", "jest-security"), "must_pass"));
        steps.push(step(run("tsc", "tsc"), "must_pass"));
        steps.push(step(run("distribution", "check-distribution"), "must_pass"));
        steps.push(step(run("compliance", "jest-compliance"), "must_pass"));
        // Oracle: what a pin would look like. Proves the mismatch is Linux-detectable.
        const detectable = appJson.name !== moduleName;
        notes.push(
          `oracle (string compare app.json name vs AppDelegate withModuleName): mismatch detectable on Linux = ${detectable}`,
        );
      },
    );
    notes.push(
      'No Linux gate compares app.json `name` with AppDelegate.swift `withModuleName`. A rename ships a bundle whose only registered component is "PickleSenseiApp" while the native host asks for "PickleSensei" — RN raises "Application PickleSensei has not been registered" at launch (INFERRED from RN AppRegistry semantics; not executed on Apple hardware here).',
    );
    return {
      id: "S2",
      title:
        "app.json name → PickleSenseiApp; is the AppDelegate module-name mismatch caught on Linux?",
      steps,
      notes,
      classification: classify(steps, true),
    };
  },

  S3() {
    const steps = [];
    const notes = [];
    // 32 alphanumerics after sk_ — shaped exactly like a RevenueCat secret key.
    const fakeSecret = "sk_" + "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
    currentScenario = "S3-sk-key-in-runtimeConfig";
    withMutations(
      [[P.runtimeConfig, (t) => t.replace(/'appl_[A-Za-z0-9]+'/, `'${fakeSecret}'`)]],
      () => {
        steps.push(step(run("security", "jest-security"), "must_fail"));
      },
    );
    // Variant: short sk_ (below the 24-char regex floor) — must still be
    // rejected by the runtimeConfig literal allow-list.
    currentScenario = "S3b-short-sk-key";
    withMutations(
      [[P.runtimeConfig, (t) => t.replace(/'appl_[A-Za-z0-9]+'/, `'sk_short1234'`)]],
      () => {
        steps.push(step(run("security", "jest-security"), "must_fail"));
      },
    );
    // Variant: secret-shaped key smuggled into Info.plist (shipped root).
    currentScenario = "S3c-sk-key-in-Info.plist";
    withMutations(
      [
        [
          P.infoPlist,
          (t) =>
            t.replace(
              "<key>CFBundleDisplayName</key>",
              `<key>RCSecret</key>\n\t<string>${fakeSecret}</string>\n\t<key>CFBundleDisplayName</key>`,
            ),
        ],
      ],
      () => {
        steps.push(step(run("security", "jest-security"), "must_fail"));
      },
    );
    // Variant: secret-shaped key in project.pbxproj (INFOPLIST_KEY_* build
    // settings flow into the shipped Info.plist, yet *.xcodeproj is outside
    // SHIPPED_SOURCE_ROOTS).
    currentScenario = "S3d-sk-key-in-pbxproj";
    withMutations(
      [
        [
          P.pbxproj,
          (t) =>
            t.replace(
              /(\t\t\t\tMARKETING_VERSION = 1\.0;\n)/,
              `$1\t\t\t\tINFOPLIST_KEY_RCSecret = ${fakeSecret};\n`,
            ),
        ],
      ],
      () => {
        const r = run("security", "jest-security");
        steps.push(step(r, "observe"));
        const d = run("distribution", "check-distribution");
        steps.push(step(d, "observe"));
        if (r.exit === 0 && d.exit === 0) {
          notes.push(
            "GAP: a secret-shaped `sk_…` value placed in project.pbxproj (INFOPLIST_KEY_* build setting, injected into the shipped Info.plist) is not scanned — be-mobile-security-secrets SHIPPED_SOURCE_ROOTS (test.ts:183-191) covers ios/PickleSensei and ios/LocalPods but not ios/PickleSensei.xcodeproj; check:distribution has no secret scan.",
          );
        }
      },
    );
    return {
      id: "S3",
      title:
        "RevenueCat key replaced by sk_-prefixed secret → be-mobile-security-secrets must fail",
      steps,
      notes,
      classification: classify(steps, false),
    };
  },

  S6() {
    const steps = [];
    const notes = [];
    const setBuild =
      (value, which = "both") =>
      (t) => {
        let n = 0;
        return t.replace(/CURRENT_PROJECT_VERSION = 1;/g, (m) => {
          n += 1;
          if (which === "both") return `CURRENT_PROJECT_VERSION = ${value};`;
          // pbxproj lists Debug first, Release second.
          if (which === "release" && n === 2) return `CURRENT_PROJECT_VERSION = ${value};`;
          return m;
        });
      };
    const setManifestBuild = (value) => (t) =>
      t.replace(/"buildNumber":\s*1\b/, `"buildNumber": ${value}`);
    currentScenario = "S6-build-zero";
    withMutations(
      [
        [P.pbxproj, setBuild(0)],
        [P.manifest, setManifestBuild(0)],
      ],
      () => {
        steps.push(step(run("releaseManifest", "release-manifest"), "must_fail"));
        steps.push(step(run("distribution", "check-distribution"), "observe"));
      },
    );
    for (const [tag, value] of [
      ["negative", -1],
      ["fractional", 1.5],
      ["string", '"1"'],
    ]) {
      currentScenario = `S6-build-${tag}`;
      withMutations([[P.manifest, setManifestBuild(value)]], () => {
        steps.push(step(run("releaseManifest", "release-manifest"), "must_fail"));
      });
    }
    // Variant: Release configuration alone drops to 0 while Debug stays 1 and
    // the manifest says 1 — the archive Apple receives is Release.
    currentScenario = "S6-release-only-build-zero";
    withMutations([[P.pbxproj, setBuild(0, "release")]], () => {
      const src = wtRead(P.pbxproj);
      notes.push(
        `Release-only mutation: CURRENT_PROJECT_VERSION occurrences = ${(src.match(/CURRENT_PROJECT_VERSION = (\d+);/g) ?? []).join(" | ")}`,
      );
      const r = run("releaseManifest", "release-manifest");
      const d = run("distribution", "check-distribution");
      steps.push(step(r, "observe"));
      steps.push(step(d, "observe"));
      if (r.exit === 0 && d.exit === 0) {
        notes.push(
          'GAP: with Debug CURRENT_PROJECT_VERSION = 1 and Release CURRENT_PROJECT_VERSION = 0 both gates stay green — check-release-manifest.mjs:52-55 uses `includes("CURRENT_PROJECT_VERSION = 1;")` (any one match) and check-ios-distribution.mjs:39-42 only requires /\\d+/. The Release archive would carry build 0.',
        );
      }
    });
    currentScenario = "S6-release-only-marketing-drift";
    withMutations(
      [
        [
          P.pbxproj,
          (t) => {
            let n = 0;
            return t.replace(/MARKETING_VERSION = 1\.0;/g, (m) => {
              n += 1;
              return n === 2 ? "MARKETING_VERSION = 0.9;" : m;
            });
          },
        ],
      ],
      () => {
        const r = run("releaseManifest", "release-manifest");
        const d = run("distribution", "check-distribution");
        steps.push(step(r, "observe"));
        steps.push(step(d, "observe"));
        if (r.exit === 0 && d.exit === 0) {
          notes.push(
            "GAP: Release MARKETING_VERSION = 0.9 while Debug stays 1.0 also passes both gates (same includes/any-match logic).",
          );
        }
      },
    );
    return {
      id: "S6",
      title:
        "CURRENT_PROJECT_VERSION=0 + manifest buildNumber 0 → check-release-manifest must reject",
      steps,
      notes,
      classification: classify(steps, false),
    };
  },

  S7() {
    currentScenario = "S7-ats-local-networking-false";
    const steps = [];
    const notes = [];
    const before = baselineDistributionLines();
    withMutations(
      [
        [
          P.infoPlist,
          (t) => t.replace(/(<key>NSAllowsLocalNetworking<\/key>\s*)<true\/>/, "$1<false/>"),
        ],
      ],
      () => {
        const d = run("distribution", "check-distribution");
        steps.push(step(d, "must_pass"));
        steps.push(step(run("compliance", "jest-compliance"), "must_pass"));
        steps.push(step(run("security", "jest-security"), "must_pass"));
        const after = distributionLines(d.stdout);
        const same = JSON.stringify(before) === JSON.stringify(after);
        notes.push(
          `check:distribution output identical to baseline line-for-line: ${same} (${after.length} lines)`,
        );
        if (!same) {
          notes.push(`diff: ${JSON.stringify({ before, after })}`);
        }
      },
    );
    // Variant: remove the key entirely — same silence expected.
    currentScenario = "S7b-ats-local-networking-removed";
    withMutations(
      [[P.infoPlist, (t) => t.replace(/\s*<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/, "")]],
      () => {
        steps.push(step(run("distribution", "check-distribution"), "must_pass"));
        steps.push(step(run("security", "jest-security"), "must_pass"));
      },
    );
    // Contrast: the relaxations that ARE pinned.
    currentScenario = "S7c-ats-arbitrary-loads-true";
    withMutations(
      [
        [
          P.infoPlist,
          (t) => t.replace(/(<key>NSAllowsArbitraryLoads<\/key>\s*)<false\/>/, "$1<true/>"),
        ],
      ],
      () => {
        steps.push(step(run("distribution", "check-distribution"), "must_fail"));
        steps.push(step(run("security", "jest-security"), "must_fail"));
      },
    );
    currentScenario = "S7d-ats-exception-domain";
    withMutations(
      [
        [
          P.infoPlist,
          (t) =>
            t.replace(
              /(<key>NSAllowsLocalNetworking<\/key>\s*<true\/>)/,
              "$1\n\t\t<key>NSExceptionDomains</key>\n\t\t<dict>\n\t\t\t<key>supabase.co</key>\n\t\t\t<dict>\n\t\t\t\t<key>NSExceptionAllowsInsecureHTTPLoads</key>\n\t\t\t\t<true/>\n\t\t\t</dict>\n\t\t</dict>",
            ),
        ],
      ],
      () => {
        const d = run("distribution", "check-distribution");
        steps.push(step(d, "observe"));
        steps.push(step(run("security", "jest-security"), "must_fail"));
        if (d.exit === 0) {
          notes.push(
            "check:distribution does not notice an NSExceptionDomains insecure-HTTP exception; only be-mobile-security-secrets pins it.",
          );
        }
      },
    );
    notes.push(
      "NSAllowsLocalNetworking=true ships in the Release Info.plist (apps/mobile/ios/PickleSensei/Info.plist NSAppTransportSecurity) and no Linux gate pins it in either direction: flipping it to false or deleting it changes nothing. It is the RN template default for the Metro dev server; ATS-wise it only relaxes local-network (RFC1918/.local) cleartext, so severity is polish, but it is UNPINNED and undocumented.",
    );
    return {
      id: "S7",
      title: "NSAllowsLocalNetworking=false → no Linux gate changes (ATS relaxation unpinned)",
      steps,
      notes,
      classification: classify(steps, true),
    };
  },

  S8() {
    const steps = [];
    const notes = [];
    const ipad =
      /<key>UISupportedInterfaceOrientations~ipad<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
        wtRead(P.infoPlist),
      );
    const ipadOrientations = Array.from(
      (ipad?.[1] ?? "").matchAll(/<string>([^<]+)<\/string>/g),
      (m) => m[1],
    );
    notes.push(
      `Info.plist UISupportedInterfaceOrientations~ipad = [${ipadOrientations.join(", ")}] — dead while TARGETED_DEVICE_FAMILY = 1, live (landscape iPad) the moment 2 is added.`,
    );
    currentScenario = "S8-device-family-1-2";
    withMutations(
      [
        [
          P.pbxproj,
          (t) => t.replace(/TARGETED_DEVICE_FAMILY = 1;/g, 'TARGETED_DEVICE_FAMILY = "1,2";'),
        ],
      ],
      () => {
        steps.push(step(run("distribution", "check-distribution"), "must_fail"));
        steps.push(step(run("compliance", "jest-compliance"), "observe"));
      },
    );
    // Variant: only the Release configuration goes universal.
    currentScenario = "S8b-release-only-1-2";
    withMutations(
      [
        [
          P.pbxproj,
          (t) => {
            let n = 0;
            return t.replace(/TARGETED_DEVICE_FAMILY = 1;/g, (m) => {
              n += 1;
              return n === 2 ? 'TARGETED_DEVICE_FAMILY = "1,2";' : m;
            });
          },
        ],
      ],
      () => {
        steps.push(step(run("distribution", "check-distribution"), "must_fail"));
      },
    );
    // Variant: Release configuration becomes iPad-ONLY (`2`). No "1,2" literal
    // and Debug still says 1.
    currentScenario = "S8c-release-only-ipad";
    withMutations(
      [
        [
          P.pbxproj,
          (t) => {
            let n = 0;
            return t.replace(/TARGETED_DEVICE_FAMILY = 1;/g, (m) => {
              n += 1;
              return n === 2 ? "TARGETED_DEVICE_FAMILY = 2;" : m;
            });
          },
        ],
      ],
      () => {
        const d = run("distribution", "check-distribution");
        steps.push(step(d, "observe"));
        if (d.exit === 0) {
          notes.push(
            'GAP: Release TARGETED_DEVICE_FAMILY = 2 (iPad-only archive) with Debug = 1 passes check:distribution — check-ios-distribution.mjs:44-48 only requires one `= 1;` match and the absence of the literal "1,2".',
          );
        }
      },
    );
    // Variant: quoted "1" — semantically iPhone-only but spelled differently.
    currentScenario = "S8d-quoted-1";
    withMutations(
      [
        [
          P.pbxproj,
          (t) => t.replace(/TARGETED_DEVICE_FAMILY = 1;/g, 'TARGETED_DEVICE_FAMILY = "1";'),
        ],
      ],
      () => {
        const d = run("distribution", "check-distribution");
        steps.push(step(d, "observe"));
        notes.push(
          `quoted TARGETED_DEVICE_FAMILY = "1"; → check:distribution exit ${d.exit} (${d.exit === 0 ? "accepted" : "rejected — strict spelling, fail-safe"})`,
        );
      },
    );
    return {
      id: "S8",
      title:
        'TARGETED_DEVICE_FAMILY="1,2" → check:distribution must fail; ~ipad landscape orientations go live',
      steps,
      notes,
      classification: classify(steps, false),
    };
  },

  // ─── S4 / S5 / S9: runtime attacks live as jest suites under
  // apps/mobile/__tests__/attack/ (they need the RN jest preset). The harness
  // runs them from the same throw-away worktree so the artifact set is one.
  S4: () => {
    currentScenario = "S4-hermes-absent-release";
    const r = run("attackS4", "jest-attack");
    const passed = (r.stdout + r.stderr).match(/Tests:\s+(\d+) passed, (\d+) total/);
    return {
      id: "S4",
      title:
        "index.js with global.HermesInternal undefined and __DEV__=false → installPromiseRejectionTracking no-ops without throwing",
      steps: [step(r, "must_pass")],
      notes: [
        `jest: ${passed ? `${passed[1]}/${passed[2]} passed` : "see log"} — covers HermesInternal undefined / {} / non-function tracker, __DEV__ short-circuit, 25 rapid isolated re-entries, and hostile rejection payloads (circular, symbol, bigint, 2 MB string, \\u202e, throwing toJSON) through the tracker callbacks.`,
      ],
      classification: classify([step(r, "must_pass")], false),
    };
  },
  S5: () => {
    currentScenario = "S5-null-api-base-settings";
    const r = run("attackS5", "jest-attack");
    const passed = (r.stdout + r.stderr).match(/Tests:\s+(\d+) passed, (\d+) total/);
    return {
      id: "S5",
      title:
        "API_BASE_URL=null (real runtimeConfig.ts recompiled with the literal nulled) → SettingsScreen legal rows hidden, no 'null/privacy' ever reaches Linking",
      steps: [step(r, "must_pass")],
      notes: [
        `jest: ${passed ? `${passed[1]}/${passed[2]} passed` : "see log"} — legalPrivacyUrl/legalTermsUrl derive to null, both rows absent, every remaining pressable pressed twice with Linking.openURL spied.`,
      ],
      classification: classify([step(r, "must_pass")], false),
    };
  },
  S9: () => {
    currentScenario = "S9-appstate-review-interleave";
    const r = run("attackS9", "jest-attack");
    const passed = (r.stdout + r.stderr).match(/Tests:\s+(\d+) passed, (\d+) total/);
    return {
      id: "S9",
      title:
        "AppState background→active while requestReview is pending → native module called once per scored analysis",
      steps: [step(r, "must_pass")],
      notes: [
        `jest: ${passed ? `${passed[1]}/${passed[2]} passed` : "see log"} — appStoreReview registers no AppState listener; transitions mid-delay, mid-flight Settings Rate, 7-report bursts, rejecting/hanging native module and kv outage all keep requestReview at exactly the committed count.`,
      ],
      classification: classify([step(r, "must_pass")], false),
    };
  },
};

const order = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"];
for (const id of order) {
  if (only && !only.includes(id)) continue;
  try {
    record(scenarios[id]());
  } catch (error) {
    record({
      id,
      title: `${id} harness error`,
      steps: [],
      notes: [String(error?.stack ?? error)],
      classification: "ERROR",
    });
  }
}

summary.finishedAt = new Date().toISOString();
summary.verdict = summary.scenarios.map((s) => `${s.id}=${s.classification}`).join(" ");
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`\nsummary: ${summary.verdict}`);
console.log(`artifacts: ${relative(repoRoot, outDir)}`);

const broken = summary.scenarios.filter(
  (s) => s.classification === "BROKEN" || s.classification === "ERROR",
);
const gaps = summary.scenarios.filter((s) => s.classification === "GAP");
process.exitCode = broken.length > 0 || (strict && gaps.length > 0) ? 1 : 0;
