#!/usr/bin/env node
// Companion to gate-mutations.mjs: does the CI-gated mobile jest suite catch the
// PrivacyInfo.xcprivacy mutations that check:distribution accepts (D7–D9)?
//
// Mutates the real file in place, runs the two jest suites that read it, and
// restores the byte-exact original from an in-memory copy (plain file write —
// no git commands). Run from repo root:
//   node tools/release/__adjudicate__/jest-privacy-coverage.mjs [out.json]
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mobile = join(repoRoot, "apps/mobile");
const file = join(mobile, "ios/PickleSensei/PrivacyInfo.xcprivacy");
const SUITES = [
  "__tests__/wf/fix-9-privacyManifestCollectedData.test.ts",
  "__tests__/wf/flow-app-store-compliance-ios-config.test.ts",
];

/** Replace the whole <array>…</array> that follows <key>{key}</key> (depth-aware). */
function emptyArray(xml, key) {
  const marker = `<key>${key}</key>`;
  const keyIdx = xml.indexOf(marker);
  if (keyIdx < 0) throw new Error(`missing ${marker}`);
  const start = xml.indexOf("<array>", keyIdx);
  const re = /<(\/?)array>/g;
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(xml)) !== null) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) return xml.slice(0, start) + "<array/>" + xml.slice(m.index + m[0].length);
  }
  throw new Error(`${key} array never closes`);
}

const MUTATIONS = [
  { id: "J0", title: "baseline (no mutation)", expect: "PASS", fn: (t) => t },
  {
    id: "J7",
    title: "NSPrivacyTracking flipped to true",
    expect: "FAIL",
    fn: (t) =>
      t.replace(
        /<key>NSPrivacyTracking<\/key>\s*<false\/>/,
        "<key>NSPrivacyTracking</key>\n\t<true/>",
      ),
  },
  {
    id: "J8",
    title: "NSPrivacyAccessedAPITypes emptied",
    expect: "FAIL",
    fn: (t) => emptyArray(t, "NSPrivacyAccessedAPITypes"),
  },
  {
    id: "J9",
    title: "NSPrivacyCollectedDataTypes emptied",
    expect: "FAIL",
    fn: (t) => emptyArray(t, "NSPrivacyCollectedDataTypes"),
  },
];

const original = readFileSync(file);
const results = [];
try {
  for (const m of MUTATIONS) {
    const mutated = m.fn(original.toString("utf8"));
    if (m.id !== "J0" && mutated === original.toString("utf8")) throw new Error(`${m.id} no-op`);
    writeFileSync(file, mutated);
    const r = spawnSync("npx", ["jest", "--ci", "--silent", ...SUITES], {
      cwd: mobile,
      encoding: "utf8",
    });
    const observed = r.status === 0 ? "PASS" : "FAIL";
    const failing = (r.stderr + r.stdout)
      .split("\n")
      .filter((l) => /^\s+●\s/.test(l))
      .slice(0, 6);
    results.push({
      id: m.id,
      title: m.title,
      expect: m.expect,
      exit: r.status,
      observed,
      verdict: observed === m.expect ? "JEST_CATCHES" : "JEST_GAP",
      failing,
    });
    writeFileSync(file, original);
  }
} finally {
  writeFileSync(file, original);
}
const restored = readFileSync(file).equals(original);
const sha = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).stdout.trim();
console.log(`# jest privacy-manifest coverage @ ${sha} (file restored byte-exact: ${restored})`);
for (const r of results) {
  console.log(
    `${r.verdict.padEnd(13)} ${r.id} exit=${r.exit} expect=${r.expect} observed=${r.observed}  ${r.title}`,
  );
  for (const f of r.failing) console.log(`    ${f.trim()}`);
}
if (process.argv[2])
  writeFileSync(process.argv[2], JSON.stringify({ sha, restored, results }, null, 2) + "\n");
