#!/usr/bin/env node
/**
 * S8 — two near-simultaneous `fastlane ios beta` (or `release`) invocations.
 *
 * Plane boundary: fastlane, App Store Connect and Xcode only exist on a Mac.
 * This script does NOT run fastlane and claims nothing about Apple runtime
 * behaviour. What it does, on Linux:
 *
 *   1. Static extraction of the build-number derivation in
 *      apps/mobile/ios/fastlane/Fastfile (both lanes read
 *      latest_testflight_build_number(...) + 1, then build, then upload —
 *      read-then-write with no lock, no re-read, no `ensure_*` guard).
 *   2. A deterministic model of two operators racing that derivation (seeded
 *      interleavings) to show every interleaving where both reads precede
 *      either upload yields the SAME build number for both archives.
 *   3. A repository-wide grep for any artifact/check that records or verifies
 *      an uploaded build number (RC record, manifest entry, CI step, test).
 *
 * Output: JSON report to stdout (and to --out <path> when given). Exit 0
 * always — this is evidence collection, not a gate.
 *
 * Usage: node tools/release/__attack__/s8-fastlane-build-number-race.mjs [--out report.json]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { seededRandom } from "./lib/sandbox.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const outIdx = process.argv.indexOf("--out");
const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : null;

// 1. Static extraction ------------------------------------------------------
const fastfilePath = "apps/mobile/ios/fastlane/Fastfile";
const fastfile = readFileSync(join(repoRoot, fastfilePath), "utf8").split("\n");
const derivations = fastfile
  .map((line, i) => ({ line: i + 1, text: line.trim() }))
  .filter((l) => l.text.includes("latest_testflight_build_number"));
const guards = fastfile
  .map((line, i) => ({ line: i + 1, text: line.trim() }))
  .filter((l) =>
    /ensure_|lock|mutex|flock|increment_build_number|get_build_number|CURRENT_PROJECT_VERSION=/.test(
      l.text,
    ),
  );

// 2. Deterministic race model -----------------------------------------------
// Each operator executes: READ (latest+1) → BUILD → UPLOAD. ASC accepts an
// upload iff its build number is strictly greater than the current latest.
function simulate(seed, operators = 2, rounds = 200) {
  const rnd = seededRandom(seed);
  let duplicates = 0;
  let rejectedUploads = 0;
  let serialized = 0;
  const examples = [];
  for (let r = 0; r < rounds; r += 1) {
    let latest = 0;
    const ops = Array.from({ length: operators }, (_, id) => ({
      id,
      step: 0,
      number: null,
    }));
    const numbers = [];
    const trace = [];
    while (ops.some((o) => o.step < 3)) {
      const live = ops.filter((o) => o.step < 3);
      const o = live[Math.floor(rnd() * live.length)];
      if (o.step === 0) {
        o.number = latest + 1; // latest_testflight_build_number(...) + 1
        trace.push(`op${o.id}:read→${o.number}`);
      } else if (o.step === 1) {
        trace.push(`op${o.id}:build(${o.number})`);
      } else {
        if (o.number > latest) {
          latest = o.number;
          trace.push(`op${o.id}:upload(${o.number}) accepted`);
        } else {
          rejectedUploads += 1;
          trace.push(`op${o.id}:upload(${o.number}) REJECTED (not > ${latest})`);
        }
        numbers.push(o.number);
      }
      o.step += 1;
    }
    if (new Set(numbers).size < numbers.length) {
      duplicates += 1;
      if (examples.length < 3) examples.push(trace.join(" ; "));
    } else {
      serialized += 1;
    }
  }
  return { seed, operators, rounds, duplicates, serialized, rejectedUploads, examples };
}

// 3. Repository grep for build-number bookkeeping ----------------------------
function gitGrep(pattern) {
  try {
    return execFileSync(
      "git",
      [
        "grep",
        "-n",
        "-I",
        "-E",
        pattern,
        "--",
        ".",
        ":(exclude)node_modules",
        ":(exclude)tools/release/__attack__",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
}
const bookkeeping = {
  buildNumberRecordedAnywhere: gitGrep("latest_testflight_build_number|testflight_build_number"),
  rcRecordOrManifestBuildEntries: gitGrep('"buildNumber"|build\\.<BUILD>|-build\\.'),
  ciStepsTouchingFastlane: gitGrep("fastlane").filter((l) => l.startsWith(".github/")),
  testsMentioningBuildNumber: gitGrep("build number|buildNumber").filter((l) =>
    /__tests__|\.test\.|_test\./.test(l),
  ),
};

const report = {
  scenario: "S8 two near-simultaneous fastlane beta/release invocations",
  plane: "mac (fastlane/ASC) — NOT executed; Linux static + model only",
  classification: "UNKNOWN on Linux (Apple runtime); INFERRED from Fastfile text",
  fastfile: {
    path: fastfilePath,
    buildNumberDerivations: derivations,
    guardsFound: guards,
    inferred:
      "Both lanes compute latest_testflight_build_number(...)+1 once, before a multi-minute archive, and never re-read or compare before upload_to_testflight/upload_to_app_store. Two operators (or one operator retrying in a second shell) whose reads both precede the first upload derive the same number; ASC then rejects the second upload as a non-increasing CFBundleVersion, or — if the first upload is still processing and the second lands first — the FIRST archive is the one rejected. Which archive wins is decided by upload order, not by which was audited.",
  },
  raceModel: [simulate(0x1a2b3c), simulate(20260904), simulate(7)],
  repositoryBookkeeping: bookkeeping,
  detectionOnLinux:
    bookkeeping.ciStepsTouchingFastlane.length === 0 &&
    bookkeeping.testsMentioningBuildNumber.length === 0
      ? "none: no CI step, test, or committed artifact records/validates uploaded build numbers; manifest.versionScheme.buildNumber stays 1 because the lane injects CURRENT_PROJECT_VERSION via xcargs without touching project.pbxproj (Fastfile L43-47)"
      : "see repositoryBookkeeping",
};

const json = `${JSON.stringify(report, null, 2)}\n`;
process.stdout.write(json);
if (outPath) writeFileSync(outPath, json);
