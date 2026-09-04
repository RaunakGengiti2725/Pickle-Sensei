#!/usr/bin/env node
// Adjudication reproduction harness for area `release-config-docs`.
//
// Copies the two Linux release gates (tools/release/check-release-manifest.mjs
// and apps/mobile/scripts/check-ios-distribution.mjs) plus every file they read
// into a scratch root, applies ONE mutation per scenario, runs the gate, and
// records whether the gate caught the mutation. `expectGate: "FAIL"` means a
// correct gate must reject the mutated tree; `GAP_REPRODUCED` means it did not.
//
// Never touches the real checkout. Exit code is always 0; the JSON/log output
// is the evidence. Run: node tools/release/__adjudicate__/gate-mutations.mjs
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const RELEASE_GATE = {
  name: "release:check",
  script: "tools/release/check-release-manifest.mjs",
  cwd: ".",
  files: [
    "tools/release/check-release-manifest.mjs",
    "infra/release/release-manifest.json",
    "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj",
    "apps/mobile/android/app/build.gradle",
    "apps/mobile/src/config/runtimeConfig.ts",
  ],
};

const DIST_GATE = {
  name: "check:distribution",
  script: "apps/mobile/scripts/check-ios-distribution.mjs",
  cwd: "apps/mobile",
  files: [
    "apps/mobile/scripts/check-ios-distribution.mjs",
    "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj",
    "apps/mobile/ios/PickleSensei/Info.plist",
    "apps/mobile/ios/PickleSensei/PrivacyInfo.xcprivacy",
    "apps/mobile/ios/PickleSensei/PickleSensei.entitlements",
    "apps/mobile/ios/Podfile.lock",
    "apps/mobile/ios/fastlane/Fastfile",
    "apps/mobile/ios/fastlane/Appfile",
  ],
};

const PBX = "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj";
const GRADLE = "apps/mobile/android/app/build.gradle";
const RTC = "apps/mobile/src/config/runtimeConfig.ts";
const MANIFEST = "infra/release/release-manifest.json";
const FASTFILE = "apps/mobile/ios/fastlane/Fastfile";
const XCPRIVACY = "apps/mobile/ios/PickleSensei/PrivacyInfo.xcprivacy";
const INFO_PLIST = "apps/mobile/ios/PickleSensei/Info.plist";

/** Replace only the Nth (0-based) occurrence of `needle` in `text`. */
function replaceNth(text, needle, replacement, n) {
  let idx = -1;
  for (let i = 0; i <= n; i += 1) {
    idx = text.indexOf(needle, idx + 1);
    if (idx < 0) throw new Error(`occurrence ${n} of ${JSON.stringify(needle)} not found`);
  }
  return text.slice(0, idx) + replacement + text.slice(idx + needle.length);
}

/** Append a conditional override right after the Nth unconditional `setting = value;` (default: Release). */
function addConditional(setting, value, condition, override, n = 1) {
  return (pbx) =>
    replaceNth(
      pbx,
      `${setting} = ${value};`,
      `${setting} = ${value};\n\t\t\t\t"${setting}[${condition}]" = ${override};`,
      n,
    );
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function editJson(fn) {
  return (text) => JSON.stringify(fn(JSON.parse(text)), null, 2) + "\n";
}

// Each scenario: { id, title, gate, expectGate, mutate: { [relPath]: (text) => text | null (delete) } }
const SCENARIOS = [
  { id: "R0", title: "baseline (no mutation)", gate: RELEASE_GATE, expectGate: "PASS", mutate: {} },
  {
    id: "R1",
    title: "pbxproj: Release configuration MARKETING_VERSION drifts to 1.1 (Debug still 1.0)",
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: {
      [PBX]: (t) => replaceNth(t, "MARKETING_VERSION = 1.0;", "MARKETING_VERSION = 1.1;", 1),
    },
  },
  {
    id: "R2",
    title: "pbxproj: Release configuration CURRENT_PROJECT_VERSION drifts to 7 (Debug still 1)",
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: {
      [PBX]: (t) =>
        replaceNth(t, "CURRENT_PROJECT_VERSION = 1;", "CURRENT_PROJECT_VERSION = 7;", 1),
    },
  },
  {
    id: "R3",
    title:
      "pbxproj: BOTH configurations set MARKETING_VERSION = 1.1, old value survives only in a /* comment */",
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: {
      [PBX]: (t) =>
        t
          .split("MARKETING_VERSION = 1.0;")
          .join("MARKETING_VERSION = 1.1; /* was MARKETING_VERSION = 1.0; */"),
    },
  },
  {
    id: "R4",
    title: 'build.gradle: versionName "1.1" with the old value kept in a // comment',
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: {
      [GRADLE]: (t) => t.replace('versionName "1.0"', 'versionName "1.1" // was versionName "1.0"'),
    },
  },
  {
    id: "R5",
    title: "build.gradle: versionCode 12 with the old value kept in a // comment",
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: {
      [GRADLE]: (t) => t.replace("versionCode 1\n", "versionCode 12 // was versionCode 1\n"),
    },
  },
  {
    id: "R6",
    title: "runtimeConfig.ts: APP_VERSION = '1.1' with the old line kept as a // comment",
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: {
      [RTC]: (t) =>
        t.replace(
          "const APP_VERSION = '1.0';",
          "// const APP_VERSION = '1.0';\nconst APP_VERSION = '1.1';",
        ),
    },
  },
  {
    id: "R7",
    title: 'runtimeConfig.ts: APP_VERSION = "1.0" (same value, double quotes) — should still PASS',
    gate: RELEASE_GATE,
    expectGate: "PASS",
    mutate: { [RTC]: (t) => t.replace("const APP_VERSION = '1.0';", 'const APP_VERSION = "1.0";') },
  },
  {
    id: "R8",
    title: "manifest: schemaVersion 1 -> 99",
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: { [MANIFEST]: editJson((m) => ({ ...m, schemaVersion: 99 })) },
  },
  {
    id: "R9",
    title: "manifest: releaseBlockingSteps emptied",
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: { [MANIFEST]: editJson((m) => ({ ...m, releaseBlockingSteps: [] })) },
  },
  {
    id: "R10",
    title:
      "manifest: irreversibleActions reduced to a single unrelated entry (app_store_submission etc. removed)",
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: {
      [MANIFEST]: editJson((m) => ({
        ...m,
        irreversibleActions: [{ id: "something_else", requiresHumanAuthorization: true }],
      })),
    },
  },
  {
    id: "R11",
    title: "manifest: every rollbackHooks[].requiresHumanAuthorization flipped to false",
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: {
      [MANIFEST]: editJson((m) => ({
        ...m,
        rollbackHooks: m.rollbackHooks.map((h) => ({ ...h, requiresHumanAuthorization: false })),
      })),
    },
  },
  {
    id: "R12",
    title:
      "manifest: duplicate monitoring hook id (silent_failure_rate twice, one downgraded to P1)",
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: {
      [MANIFEST]: editJson((m) => ({
        ...m,
        monitoringHooks: [
          ...m.monitoringHooks,
          { id: "silent_failure_rate", signal: "dup", alarm: "dup", severity: "P1" },
        ],
      })),
    },
  },
  {
    id: "R13",
    title: 'manifest: monitoring hook alarm set to "" (empty string)',
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: {
      [MANIFEST]: editJson((m) => ({
        ...m,
        monitoringHooks: m.monitoringHooks.map((h) =>
          h.id === "flag_drift" ? { ...h, alarm: "" } : h,
        ),
      })),
    },
  },
  {
    id: "R14",
    title:
      "manifest: production.apiOrigin set to the real committed origin (control: gate SHOULD fail)",
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: {
      [MANIFEST]: editJson((m) => ({
        ...m,
        environments: {
          ...m.environments,
          production: {
            ...m.environments.production,
            apiOrigin: "https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api",
          },
        },
      })),
    },
  },
  {
    id: "R15",
    title:
      "manifest: file missing (diagnostic quality; expect FAIL with a check line, not a stack trace)",
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: { [MANIFEST]: () => null },
  },
  {
    id: "R16",
    title: "manifest: malformed JSON (diagnostic quality)",
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: { [MANIFEST]: (t) => t.slice(0, -3) },
  },
  {
    id: "R17",
    title: "manifest: rollbackHooks is a string, not an array (diagnostic quality)",
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: { [MANIFEST]: editJson((m) => ({ ...m, rollbackHooks: "nope" })) },
  },

  { id: "D0", title: "baseline (no mutation)", gate: DIST_GATE, expectGate: "PASS", mutate: {} },
  {
    id: "D1",
    title:
      "pbxproj: Release configuration TARGETED_DEVICE_FAMILY = 2 (iPad-only) while Debug stays 1",
    gate: DIST_GATE,
    expectGate: "FAIL",
    mutate: {
      [PBX]: (t) => replaceNth(t, "TARGETED_DEVICE_FAMILY = 1;", "TARGETED_DEVICE_FAMILY = 2;", 1),
    },
  },
  {
    id: "D2",
    title: "pbxproj: Release configuration PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei.staging",
    gate: DIST_GATE,
    expectGate: "FAIL",
    mutate: {
      [PBX]: (t) =>
        replaceNth(
          t,
          "PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei;",
          "PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei.staging;",
          1,
        ),
    },
  },
  {
    id: "D3",
    title:
      "pbxproj: Release configuration DEVELOPMENT_TEAM = ZZZZZZZZZZ (Appfile team only matches Debug)",
    gate: DIST_GATE,
    expectGate: "FAIL",
    mutate: {
      [PBX]: (t) =>
        replaceNth(t, "DEVELOPMENT_TEAM = H26U6W4K6V;", "DEVELOPMENT_TEAM = ZZZZZZZZZZ;", 1),
    },
  },
  {
    id: "D4",
    title: "Fastfile: distribute_external: true, old value kept in a # comment",
    gate: DIST_GATE,
    expectGate: "FAIL",
    mutate: {
      [FASTFILE]: (t) =>
        t.replace(
          "distribute_external: false, # internal testers only; external needs App Review",
          "distribute_external: true, # was distribute_external: false",
        ),
    },
  },
  {
    id: "D5",
    title: "Fastfile: submit_for_review: true, old value kept in a # comment",
    gate: DIST_GATE,
    expectGate: "FAIL",
    mutate: {
      [FASTFILE]: (t) =>
        t.replace(
          "submit_for_review: false, # review submission is a human decision",
          "submit_for_review: true, # was submit_for_review: false",
        ),
    },
  },
  {
    id: "D6",
    title: "Fastfile: key_content replaced by a base64 literal (no -----BEGIN marker)",
    gate: DIST_GATE,
    expectGate: "FAIL",
    mutate: {
      [FASTFILE]: (t) =>
        t.replace(
          'key_content: ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY")',
          'key_content: Base64.decode64("TUlJR0hBSUJBQUtDQVFFQXdvcGZha2Vwcml2YXRla2V5")',
        ),
    },
  },
  {
    id: "D7",
    title:
      "xcprivacy: NSPrivacyTracking flipped to true (check:distribution only; jest coverage tested separately)",
    gate: DIST_GATE,
    expectGate: "FAIL",
    mutate: {
      [XCPRIVACY]: (t) =>
        t.replace(
          /<key>NSPrivacyTracking<\/key>\s*<false\/>/,
          "<key>NSPrivacyTracking</key>\n\t<true/>",
        ),
    },
  },
  {
    id: "D8",
    title: "xcprivacy: NSPrivacyAccessedAPITypes emptied to <array/>",
    gate: DIST_GATE,
    expectGate: "FAIL",
    mutate: {
      [XCPRIVACY]: (t) =>
        t.replace(
          /<key>NSPrivacyAccessedAPITypes<\/key>\s*<array>[\s\S]*?<\/array>\s*(?=<key>|<\/dict>)/,
          "<key>NSPrivacyAccessedAPITypes</key>\n\t<array/>\n\t",
        ),
    },
  },
  {
    id: "D9",
    title: "xcprivacy: NSPrivacyCollectedDataTypes emptied to <array/>",
    gate: DIST_GATE,
    expectGate: "FAIL",
    mutate: {
      [XCPRIVACY]: (t) =>
        t.replace(
          /<key>NSPrivacyCollectedDataTypes<\/key>\s*<array>[\s\S]*?<\/array>\s*(?=<key>|<\/dict>)/,
          "<key>NSPrivacyCollectedDataTypes</key>\n\t<array/>\n\t",
        ),
    },
  },
  {
    id: "D10",
    title: "xcprivacy: file deleted (control: gate SHOULD fail)",
    gate: DIST_GATE,
    expectGate: "FAIL",
    mutate: { [XCPRIVACY]: () => null },
  },

  // Round 2 (adversary on 333de233): Xcode CONDITIONAL build settings —
  // `"SETTING[sdk=iphoneos*]" = value;` (also [arch=], [config=]) — override the
  // plain line for matching builds; sdk=iphoneos* IS the device/App Store archive.
  {
    id: "A0",
    title:
      'pbxproj: same-value "PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*]" override (control: PASS)',
    gate: DIST_GATE,
    expectGate: "PASS",
    mutate: {
      [PBX]: addConditional(
        "PRODUCT_BUNDLE_IDENTIFIER",
        "com.picklesensei",
        "sdk=iphoneos*",
        "com.picklesensei",
      ),
    },
  },
  {
    id: "A1",
    title: 'pbxproj: Release "MARKETING_VERSION[sdk=iphoneos*]" = 1.0.99; (plain line still 1.0)',
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: { [PBX]: addConditional("MARKETING_VERSION", "1.0", "sdk=iphoneos*", "1.0.99") },
  },
  {
    id: "A2",
    title: 'pbxproj: Release "CURRENT_PROJECT_VERSION[sdk=iphoneos*]" = 100; (plain line still 1)',
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: { [PBX]: addConditional("CURRENT_PROJECT_VERSION", "1", "sdk=iphoneos*", "100") },
  },
  {
    id: "A3",
    title:
      'pbxproj: Release "PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*]" = com.picklesensei.staging;',
    gate: DIST_GATE,
    expectGate: "FAIL",
    mutate: {
      [PBX]: addConditional(
        "PRODUCT_BUNDLE_IDENTIFIER",
        "com.picklesensei",
        "sdk=iphoneos*",
        "com.picklesensei.staging",
      ),
    },
  },
  {
    id: "A4",
    title: 'pbxproj: Release "TARGETED_DEVICE_FAMILY[sdk=iphoneos*]" = "1,2";',
    gate: DIST_GATE,
    expectGate: "FAIL",
    mutate: { [PBX]: addConditional("TARGETED_DEVICE_FAMILY", "1", "sdk=iphoneos*", '"1,2"') },
  },
  {
    id: "A5",
    title: 'pbxproj: Release "DEVELOPMENT_TEAM[sdk=iphoneos*]" = ZZZZZZZZZZ;',
    gate: DIST_GATE,
    expectGate: "FAIL",
    mutate: {
      [PBX]: addConditional("DEVELOPMENT_TEAM", "H26U6W4K6V", "sdk=iphoneos*", "ZZZZZZZZZZ"),
    },
  },
  {
    id: "A6",
    title:
      "Fastfile: `:distribute_external => true` hash-rocket, stale `distribute_external: false` elsewhere",
    gate: DIST_GATE,
    expectGate: "FAIL",
    mutate: {
      [FASTFILE]: (t) =>
        t
          .replace(
            "distribute_external: false, # internal testers only; external needs App Review",
            ":distribute_external => true,",
          )
          .replace(
            "lane :beta do\n",
            "lane :beta do\n    defaults = { distribute_external: false }\n",
          ),
    },
  },
  {
    id: "A7",
    title:
      "Fastfile: `:submit_for_review => true` hash-rocket, stale `submit_for_review: false` elsewhere",
    gate: DIST_GATE,
    expectGate: "FAIL",
    mutate: {
      [FASTFILE]: (t) =>
        t
          .replace(
            "submit_for_review: false, # review submission is a human decision",
            ":submit_for_review => true,",
          )
          .replace(
            "lane :release do\n",
            "lane :release do\n    defaults = { submit_for_review: false }\n",
          ),
    },
  },
  {
    id: "A8",
    title: "Fastfile: `:key_content => Base64.decode64(...)` hash-rocket literal",
    gate: DIST_GATE,
    expectGate: "FAIL",
    mutate: {
      [FASTFILE]: (t) =>
        t.replace(
          'key_content: ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY")',
          ':key_content => Base64.decode64("TUlJR0hBSUJBQUtDQVFFQXdvcGZha2Vwcml2YXRla2V5")',
        ),
    },
  },
  {
    id: "A9",
    title:
      "Info.plist: CFBundleShortVersionString hardcoded, $(MARKETING_VERSION) only in an XML comment",
    gate: DIST_GATE,
    expectGate: "FAIL",
    mutate: {
      [INFO_PLIST]: (t) =>
        t.replace(
          "<key>CFBundleShortVersionString</key>\n\t<string>$(MARKETING_VERSION)</string>",
          "<key>CFBundleShortVersionString</key>\n\t<string>1.0</string>\n\t<!-- <string>$(MARKETING_VERSION)</string> -->",
        ),
    },
  },
  {
    id: "A10",
    title: "build.gradle: versionCode 1 + 11 (arithmetic; effective 12)",
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: { [GRADLE]: (t) => t.replace("versionCode 1\n", "versionCode 1 + 11\n") },
  },
  {
    id: "A11",
    title:
      "manifest: rollbackHooks contains a null entry (diagnostic quality: FAIL line, not TypeError)",
    gate: RELEASE_GATE,
    expectGate: "FAIL",
    mutate: {
      [MANIFEST]: editJson((m) => ({ ...m, rollbackHooks: [...m.rollbackHooks, null] })),
    },
  },
];

function runScenario(s) {
  const root = mkdtempSync(join(tmpdir(), `adj-${s.id}-`));
  try {
    for (const rel of s.gate.files) {
      const dst = join(root, rel);
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(join(repoRoot, rel), dst);
    }
    const mutated = [];
    for (const [rel, fn] of Object.entries(s.mutate)) {
      const dst = join(root, rel);
      const before = readFileSync(dst, "utf8");
      const after = fn(before);
      if (after === null) {
        rmSync(dst);
        mutated.push(`${rel}: deleted`);
      } else {
        if (after === before) throw new Error(`${s.id}: mutation of ${rel} was a no-op`);
        writeFileSync(dst, after);
        mutated.push(
          `${rel}: ${countOccurrences(before, "\n")}→${countOccurrences(after, "\n")} lines`,
        );
      }
    }
    const r = spawnSync(process.execPath, [join(root, s.gate.script)], {
      cwd: join(root, s.gate.cwd),
      encoding: "utf8",
    });
    const observed = r.status === 0 ? "PASS" : "FAIL";
    const failLines = (r.stdout + r.stderr).split("\n").filter((l) => /^FAIL /.test(l));
    const uncaught =
      /(TypeError|SyntaxError|ENOENT|at .*\.mjs:\d+)/.test(r.stderr) && failLines.length === 0;
    let verdict;
    if (s.expectGate === observed && !uncaught) verdict = "GATE_OK";
    else if (s.expectGate === "FAIL" && observed === "PASS") verdict = "GAP_REPRODUCED";
    else if (uncaught) verdict = "GAP_UNCAUGHT_EXCEPTION";
    else verdict = "GAP_FALSE_FAIL";
    return {
      id: s.id,
      gate: s.gate.name,
      title: s.title,
      mutated,
      expectGate: s.expectGate,
      exit: r.status,
      observed,
      verdict,
      failLines,
      stderrHead: r.stderr.split("\n").slice(0, 3).join(" | "),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const results = SCENARIOS.map(runScenario);
const sha = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).stdout.trim();
console.log(`# release-config-docs gate mutation harness @ ${sha}`);
for (const r of results) {
  console.log(
    `${r.verdict.padEnd(22)} ${r.id.padEnd(4)} ${r.gate.padEnd(19)} exit=${r.exit} expect=${r.expectGate} observed=${r.observed}  ${r.title}`,
  );
  for (const m of r.mutated) console.log(`    mutation: ${m}`);
  for (const f of r.failLines) console.log(`    gate: ${f}`);
  if (r.stderrHead) console.log(`    stderr: ${r.stderrHead}`);
}
const out = process.argv[2];
if (out) {
  if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ sha, results }, null, 2) + "\n");
  console.log(`\nwrote ${out}`);
}
