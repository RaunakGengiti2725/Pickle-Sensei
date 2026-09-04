#!/usr/bin/env node
/**
 * Adversarial harness for the release-config-docs subsystem
 * (infra/release, tools/release, apps/mobile check:distribution,
 * scripts/verify-cloud.sh release stage, store-copy rules).
 *
 * Every scenario mutates a SANDBOX COPY of the relevant files (never the
 * working tree), runs the real checker against it, and compares the observed
 * exit code with the exit code the documented rule demands. A scenario is
 *   HELD   when the checker rejects the attack as the rule requires, and
 *   BROKEN when the checker accepts a state the rule forbids.
 *
 * Usage:
 *   node tools/release/__attack__/attack-release-config-docs.mjs [--json-out <file>] [--seed <n>]
 * Exit 0 when every scenario is HELD, 1 when any scenario is BROKEN — so once
 * the checkers are hardened this file doubles as a regression suite.
 *
 * It changes nothing outside $TMPDIR (or ATTACK_SANDBOX_ROOT) and the
 * optional --json-out path.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const args = process.argv.slice(2);
const jsonOut = args.includes("--json-out") ? args[args.indexOf("--json-out") + 1] : null;
const seed = Number(args.includes("--seed") ? args[args.indexOf("--seed") + 1] : 20260904);

// Deterministic PRNG (mulberry32) so "random" payloads are reproducible.
let rngState = seed >>> 0;
function rand() {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function randInt(lo, hi) {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

const sandboxRoot = mkdtempSync(
  join(process.env.ATTACK_SANDBOX_ROOT ?? tmpdir(), "release-attack-"),
);
const results = [];

const CHECKER = "tools/release/check-release-manifest.mjs";
const MANIFEST = "infra/release/release-manifest.json";
const PBXPROJ = "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj";
const GRADLE = "apps/mobile/android/app/build.gradle";
const RUNTIME = "apps/mobile/src/config/runtimeConfig.ts";
const RELEASE_INPUTS = [CHECKER, MANIFEST, PBXPROJ, GRADLE, RUNTIME];

const DIST_CHECKER = "apps/mobile/scripts/check-ios-distribution.mjs";
const DIST_INPUTS = [
  DIST_CHECKER,
  PBXPROJ,
  "apps/mobile/ios/PickleSensei/Info.plist",
  "apps/mobile/ios/PickleSensei/PrivacyInfo.xcprivacy",
  "apps/mobile/ios/PickleSensei/PickleSensei.entitlements",
  "apps/mobile/ios/Podfile.lock",
  "apps/mobile/ios/fastlane/Fastfile",
  "apps/mobile/ios/fastlane/Appfile",
];

function makeSandbox(name, files) {
  const dir = join(sandboxRoot, name);
  for (const rel of files) {
    const src = join(repoRoot, rel);
    if (!existsSync(src)) throw new Error(`missing input ${rel}`);
    const dst = join(dir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
  }
  return dir;
}

function mutate(dir, rel, fn) {
  const p = join(dir, rel);
  const before = readFileSync(p, "utf8");
  const after = fn(before);
  if (after === before) throw new Error(`mutation of ${rel} was a no-op — attack not applied`);
  writeFileSync(p, after);
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", ...opts });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runChecker(dir) {
  return run(process.execPath, [join(dir, CHECKER)]);
}
function runDistChecker(dir) {
  return run(process.execPath, [join(dir, DIST_CHECKER)]);
}

function record({ id, title, rule, expected, observed, evidence, files, extra }) {
  const held = expected === observed;
  results.push({
    id,
    title,
    rule,
    expected,
    observed,
    verdict: held ? "HELD" : "BROKEN",
    files,
    evidence,
    ...(extra ?? {}),
  });
  console.log(
    `${held ? "HELD  " : "BROKEN"} ${id} ${title}\n       expected: ${expected}\n       observed: ${observed}`,
  );
}

const tail = (s, n = 6) => s.trim().split("\n").slice(-n).join("\n");

// ---------------------------------------------------------------------------
// S1 — only the Release build configuration's MARKETING_VERSION changes.
// The manifest rule says marketingVersion MUST equal iOS MARKETING_VERSION; the
// checker uses String.includes, so the untouched Debug occurrence satisfies it.
{
  const dir = makeSandbox("s1-release-only-marketing", RELEASE_INPUTS);
  mutate(dir, PBXPROJ, (s) => {
    const idx = s.lastIndexOf("MARKETING_VERSION = 1.0;");
    if (idx < 0 || idx === s.indexOf("MARKETING_VERSION = 1.0;"))
      throw new Error("expected two occurrences");
    return `${s.slice(0, idx)}MARKETING_VERSION = 1.1;${s.slice(idx + "MARKETING_VERSION = 1.0;".length)}`;
  });
  const r = runChecker(dir);
  record({
    id: "S1a",
    title: "Release-config MARKETING_VERSION=1.1 while Debug stays 1.0 (manifest 1.0)",
    rule: "release-manifest.json versionScheme.rules.marketingVersion: MUST equal iOS MARKETING_VERSION",
    expected: "exit 1 (mismatch in the configuration that ships)",
    observed: `exit ${r.status}`,
    files: [`${CHECKER}:47-51`, `${PBXPROJ}:316`, `${PBXPROJ}:347`],
    evidence: tail(r.stdout),
  });
}
{
  const dir = makeSandbox("s1-release-only-build", RELEASE_INPUTS);
  mutate(dir, PBXPROJ, (s) => {
    const idx = s.lastIndexOf("CURRENT_PROJECT_VERSION = 1;");
    return `${s.slice(0, idx)}CURRENT_PROJECT_VERSION = 7;${s.slice(idx + "CURRENT_PROJECT_VERSION = 1;".length)}`;
  });
  const r = runChecker(dir);
  record({
    id: "S1b",
    title: "Release-config CURRENT_PROJECT_VERSION=7 while Debug stays 1 (manifest 1)",
    rule: "versionScheme.rules.buildNumber: MUST equal iOS CURRENT_PROJECT_VERSION",
    expected: "exit 1",
    observed: `exit ${r.status}`,
    files: [`${CHECKER}:52-55`, `${PBXPROJ}:307`, `${PBXPROJ}:339`],
    evidence: tail(r.stdout),
  });
}

// ---------------------------------------------------------------------------
// S2 — a release tag on a non-HEAD commit; nothing validates tag ↔ manifest ↔ SHA.
{
  const dir = join(sandboxRoot, "s2-tag-clone");
  const clone = run("git", ["clone", "-q", "--local", "--no-hardlinks", repoRoot, dir]);
  if (clone.status !== 0) throw new Error(`clone failed: ${clone.stderr}`);
  run("git", ["checkout", "-q", "4d812e1aa699014cc0521fd92fde66908043aaa8"], { cwd: dir });
  const old = run("git", ["rev-parse", "HEAD~5"], { cwd: dir }).stdout.trim();
  const tagRc = run("git", ["tag", "v1.0-build.1", old], { cwd: dir }).status;
  const bogusRc = run("git", ["tag", "v9.9-build.999", old], { cwd: dir }).status;
  if (tagRc !== 0 || bogusRc !== 0) throw new Error("tagging failed in sandbox clone");
  const checker = run(process.execPath, [CHECKER], { cwd: dir });
  const dist = run(process.execPath, ["scripts/check-ios-distribution.mjs"], {
    cwd: join(dir, "apps/mobile"),
  });
  // Static evidence: no checker/script/workflow reads git tags or pins an RC SHA.
  const grep = run(
    "git",
    ["grep", "-nE", "git tag|describe --tags|refs/tags|GITHUB_REF|rcSha|releaseSha|auditedSha"],
    {
      cwd: dir,
    },
  );
  const codeHits = grep.stdout
    .split("\n")
    .filter(
      (l) =>
        l &&
        !/^(docs|\.agents|AGENTS\.md|REVIEW\.md|infra\/release\/release-manifest\.json)/.test(l),
    );
  const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
  const manifestPinsSha = JSON.stringify(manifest).match(/\b[0-9a-f]{40}\b/) !== null;
  record({
    id: "S2",
    title:
      "tag v1.0-build.1 (and v9.9-build.999) on HEAD~5; run release:check + check:distribution",
    rule: "RELEASE_OPERATIONS.md §1 / manifest rules.gitTag: store builds only from v<version>-build.<build> on the audited RC SHA; the tag must match the RC record",
    expected: "some tool exits non-zero or at least reads tags / an RC SHA",
    observed: `release:check exit ${checker.status}; check:distribution exit ${dist.status}; tag-aware code outside docs: ${codeHits.length} hit(s); manifest pins an RC SHA: ${manifestPinsSha}`,
    files: [`${MANIFEST}:10`, "docs/RELEASE_OPERATIONS.md:35-38", `${CHECKER}:33-71`],
    evidence: `tags -> ${old}\n${codeHits.join("\n") || "(no tag-aware code)"}`,
    extra: { tagTarget: old, head: "4d812e1aa699014cc0521fd92fde66908043aaa8" },
  });
}

// ---------------------------------------------------------------------------
// S3 — verify-cloud --only release with a missing / malformed manifest must be
// recorded as `failed` (not `unavailable`, not `passed`).
function runVerifyCloudRelease(name, prep) {
  const dir = makeSandbox(name, [...RELEASE_INPUTS, "scripts/verify-cloud.sh"]);
  prep(dir);
  const artifacts = join(dir, "artifacts");
  const r = run("bash", [join(dir, "scripts/verify-cloud.sh"), "--only", "release"], {
    cwd: dir,
    env: { ...process.env, VERIFY_ARTIFACTS: artifacts },
  });
  const summaryPath = join(artifacts, "summary.json");
  const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : null;
  const stage = summary?.stages?.find((s) => s.name === "release") ?? null;
  return { r, summary, stage, summaryPath };
}
{
  const { r, summary, stage, summaryPath } = runVerifyCloudRelease("s3-manifest-deleted", (dir) =>
    rmSync(join(dir, MANIFEST)),
  );
  record({
    id: "S3a",
    title: "verify-cloud --only release with release-manifest.json deleted",
    rule: "verify-cloud policy: a stage that cannot run is failed/unavailable, never passed; exit non-zero",
    expected: "exit 1; summary.ok=false; release stage status=failed",
    observed: `exit ${r.status}; summary.ok=${summary?.ok}; release stage status=${stage?.status}`,
    files: ["scripts/verify-cloud.sh:274-280", "scripts/verify-cloud.sh:128-145"],
    evidence: `${summaryPath}\nstage note: ${stage?.note}\n${tail(r.stdout, 8)}`,
  });
}
{
  const { r, summary, stage, summaryPath } = runVerifyCloudRelease("s3-manifest-malformed", (dir) =>
    mutate(dir, MANIFEST, (s) => `${s.slice(0, randInt(10, 200))}\u0000{{{ not json`),
  );
  record({
    id: "S3b",
    title: "verify-cloud --only release with malformed (truncated + NUL) manifest JSON",
    rule: "same as S3a",
    expected: "exit 1; summary.ok=false; release stage status=failed",
    observed: `exit ${r.status}; summary.ok=${summary?.ok}; release stage status=${stage?.status}`,
    files: ["scripts/verify-cloud.sh:274-280", `${CHECKER}:33`],
    evidence: `${summaryPath}\nstage note: ${stage?.note}\n${tail(r.stdout, 8)}`,
  });
}
{
  const { r, summary, stage, summaryPath } = runVerifyCloudRelease("s3-checker-missing", (dir) =>
    rmSync(join(dir, CHECKER)),
  );
  record({
    id: "S3c",
    title: "verify-cloud --only release with the checker script itself missing",
    rule: "verify-cloud: missing prerequisite => exit 75 => status unavailable, run still FAILS",
    expected: "exit 1; summary.ok=false; release stage status=unavailable",
    observed: `exit ${r.status}; summary.ok=${summary?.ok}; release stage status=${stage?.status}`,
    files: ["scripts/verify-cloud.sh:275-278", "scripts/verify-cloud.sh:134-139"],
    evidence: `${summaryPath}\nstage note: ${stage?.note}\n${tail(r.stdout, 8)}`,
  });
}

// ---------------------------------------------------------------------------
// S4 — structural fields the checker never validates.
function manifestAttack(id, title, rule, files, edit) {
  const dir = makeSandbox(`s4-${id.toLowerCase()}`, RELEASE_INPUTS);
  mutate(dir, MANIFEST, (s) => {
    const m = JSON.parse(s);
    edit(m);
    return JSON.stringify(m, null, 2);
  });
  const r = runChecker(dir);
  record({
    id,
    title,
    rule,
    expected: "exit 1",
    observed: `exit ${r.status}`,
    files,
    evidence: tail(r.stdout, 4),
  });
}
manifestAttack(
  "S4a",
  "releaseBlockingSteps=[] and schemaVersion=99",
  "manifest $comment: single source of truth for release-blocking steps; schemaVersion is the contract version the checker was written for",
  [`${CHECKER}:33-34`, `${MANIFEST}:3`, `${MANIFEST}:45`],
  (m) => {
    m.releaseBlockingSteps = [];
    m.schemaVersion = 99;
  },
);
manifestAttack(
  "S4b",
  "releaseBlockingSteps key deleted entirely; schemaVersion='banana'",
  "same as S4a",
  [`${CHECKER}:33-34`],
  (m) => {
    delete m.releaseBlockingSteps;
    m.schemaVersion = "banana";
  },
);
manifestAttack(
  "S4c",
  "every rollbackHook.requiresHumanAuthorization=false",
  "manifest $comment + RELEASE_OPERATIONS §5: every rollback hook is an irreversible action that must not run without an explicit human GO",
  [`${CHECKER}:139-144`, `${MANIFEST}:126-165`],
  (m) => {
    for (const h of m.rollbackHooks) h.requiresHumanAuthorization = false;
  },
);
manifestAttack(
  "S4d",
  "irreversibleActions replaced by one bogus entry {id:'noop', requiresHumanAuthorization:true}",
  "release-verification skill step 2: 'every irreversible action flagged requiresHumanAuthorization' — the SET of actions is part of the contract",
  [`${CHECKER}:146-154`],
  (m) => {
    m.irreversibleActions = [{ id: "noop", requiresHumanAuthorization: true }];
  },
);
manifestAttack(
  "S4e",
  "duplicate monitoringHook ids (silent_failure_rate twice, one P1) + P0 line downgraded on the duplicate",
  "checker asserts consent/silent-failure lines are P0 via .every over hooks with that id",
  [`${CHECKER}:107-124`],
  (m) => {
    const orig = m.monitoringHooks.find((h) => h.id === "silent_failure_rate");
    m.monitoringHooks.push({ ...orig, severity: "P1" });
  },
);

// ---------------------------------------------------------------------------
// S6 — commented-out version lines satisfy substring/regex checks.
{
  const dir = makeSandbox("s6-gradle-comment", RELEASE_INPUTS);
  mutate(dir, GRADLE, (s) =>
    s.replace("versionCode 1\n", "// versionCode 1\n        versionCode 2\n"),
  );
  const r = runChecker(dir);
  record({
    id: "S6a",
    title: "build.gradle: '// versionCode 1' comment + real 'versionCode 2'",
    rule: "versionScheme.rules.buildNumber: MUST equal Android versionCode",
    expected: "exit 1",
    observed: `exit ${r.status}`,
    files: [`${CHECKER}:62-65`, `${GRADLE}:85`],
    evidence: tail(r.stdout, 4),
  });
}
{
  const dir = makeSandbox("s6-gradle-name-comment", RELEASE_INPUTS);
  mutate(dir, GRADLE, (s) =>
    s.replace('versionName "1.0"\n', '// versionName "1.0"\n        versionName "2.0"\n'),
  );
  const r = runChecker(dir);
  record({
    id: "S6b",
    title: 'build.gradle: \'// versionName "1.0"\' comment + real versionName "2.0"',
    rule: "versionScheme.rules.marketingVersion: MUST equal Android versionName",
    expected: "exit 1",
    observed: `exit ${r.status}`,
    files: [`${CHECKER}:58-61`, `${GRADLE}:86`],
    evidence: tail(r.stdout, 4),
  });
}
{
  const dir = makeSandbox("s6-runtime-comment", RELEASE_INPUTS);
  mutate(dir, RUNTIME, (s) =>
    s.replace(
      "const APP_VERSION = '1.0';",
      "// const APP_VERSION = '1.0';\nconst APP_VERSION = '2.0';",
    ),
  );
  const r = runChecker(dir);
  record({
    id: "S6c",
    title: "runtimeConfig.ts: commented-out APP_VERSION='1.0' + real APP_VERSION='2.0'",
    rule: "versionScheme.rules.marketingVersion: MUST equal APP_VERSION in runtimeConfig.ts",
    expected: "exit 1",
    observed: `exit ${r.status}`,
    files: [`${CHECKER}:67-71`, `${RUNTIME}:58`],
    evidence: tail(r.stdout, 4),
  });
}
{
  const dir = makeSandbox("s6-pbxproj-comment", RELEASE_INPUTS);
  mutate(dir, PBXPROJ, (s) =>
    s
      .split("MARKETING_VERSION = 1.0;")
      .join("MARKETING_VERSION = 3.0; /* MARKETING_VERSION = 1.0; */"),
  );
  const r = runChecker(dir);
  record({
    id: "S6d",
    title:
      "pbxproj: both MARKETING_VERSION set to 3.0 with '/* MARKETING_VERSION = 1.0; */' trailing comments",
    rule: "versionScheme.rules.marketingVersion: MUST equal iOS MARKETING_VERSION",
    expected: "exit 1",
    observed: `exit ${r.status}`,
    files: [`${CHECKER}:47-51`],
    evidence: tail(r.stdout, 4),
  });
}

// ---------------------------------------------------------------------------
// S7 — PrivacyInfo.xcprivacy mutations vs check:distribution.
const PRIVACY = "apps/mobile/ios/PickleSensei/PrivacyInfo.xcprivacy";
function stripArrayForKey(xml, key) {
  const keyIdx = xml.indexOf(`<key>${key}</key>`);
  if (keyIdx < 0) throw new Error(`key ${key} not found`);
  const arrStart = xml.indexOf("<array>", keyIdx);
  // find the matching </array> for this top-level array (nested arrays exist)
  let depth = 0;
  let i = arrStart;
  const re = /<array>|<\/array>/g;
  re.lastIndex = arrStart;
  let m;
  let arrEnd = -1;
  while ((m = re.exec(xml))) {
    depth += m[0] === "<array>" ? 1 : -1;
    if (depth === 0) {
      arrEnd = m.index + m[0].length;
      break;
    }
    i = m.index;
  }
  if (arrEnd < 0) throw new Error("unbalanced array");
  return { keyIdx, arrStart, arrEnd, i };
}
{
  const dir = makeSandbox("s7-no-accessed-api", DIST_INPUTS);
  mutate(dir, PRIVACY, (s) => {
    const { keyIdx, arrEnd } = stripArrayForKey(s, "NSPrivacyAccessedAPITypes");
    return s.slice(0, keyIdx) + s.slice(arrEnd);
  });
  const r = runDistChecker(dir);
  record({
    id: "S7a",
    title: "PrivacyInfo.xcprivacy without NSPrivacyAccessedAPITypes",
    rule: "check:distribution: accessed-API declarations present",
    expected: "exit 1",
    observed: `exit ${r.status}`,
    files: [`${DIST_CHECKER}:83-87`],
    evidence: tail(r.stdout, 4),
  });
}
{
  const dir = makeSandbox("s7-empty-accessed-api", DIST_INPUTS);
  mutate(dir, PRIVACY, (s) => {
    const { arrStart, arrEnd } = stripArrayForKey(s, "NSPrivacyAccessedAPITypes");
    return `${s.slice(0, arrStart)}<array/>${s.slice(arrEnd)}`;
  });
  const r = runDistChecker(dir);
  record({
    id: "S7b",
    title:
      "PrivacyInfo.xcprivacy with NSPrivacyAccessedAPITypes present but EMPTY (UserDefaults/FileTimestamp/BootTime reasons gone)",
    rule: "Apple required-reason APIs used by RN/Keychain/Sentry-style deps must declare reasons; an empty array is a rejection at upload (ITMS-91053)",
    expected: "exit 1",
    observed: `exit ${r.status}`,
    files: [`${DIST_CHECKER}:83-87`, `${PRIVACY}:5`],
    evidence: tail(r.stdout, 4),
  });
}
{
  const dir = makeSandbox("s7-no-collected-data", DIST_INPUTS);
  mutate(dir, PRIVACY, (s) => {
    const { arrStart, arrEnd } = stripArrayForKey(s, "NSPrivacyCollectedDataTypes");
    return `${s.slice(0, arrStart)}<array/>${s.slice(arrEnd)}`;
  });
  const r = runDistChecker(dir);
  record({
    id: "S7c",
    title:
      "PrivacyInfo.xcprivacy with ALL NSPrivacyCollectedDataType entries removed (email/name/userId/purchase… undisclosed)",
    rule: "manifest releaseBlockingSteps.privacy_disclosure_sync: PrivacyInfo NSPrivacyCollectedDataTypes MUST disclose the collected data; check:distribution is the Linux gate named by distribution_preconditions",
    expected: "exit 1",
    observed: `exit ${r.status}`,
    files: [`${DIST_CHECKER}:83-87`, `${PRIVACY}:34`, `${MANIFEST}:51-55`],
    evidence: tail(r.stdout, 4),
  });
}
{
  const dir = makeSandbox("s7-tracking-true", DIST_INPUTS);
  mutate(dir, PRIVACY, (s) =>
    s.replace(
      "<key>NSPrivacyTracking</key>\n\t<false/>",
      "<key>NSPrivacyTracking</key>\n\t<true/>",
    ),
  );
  const r = runDistChecker(dir);
  record({
    id: "S7d",
    title:
      "PrivacyInfo.xcprivacy NSPrivacyTracking flipped to true (no NSPrivacyTrackingDomains, no ATT prompt in app)",
    rule: "APP_STORE_SUBMISSION.md privacy questionnaire: app does not track; a tracking=true manifest contradicts the label and requires ATT",
    expected: "exit 1",
    observed: `exit ${r.status}`,
    files: [`${DIST_CHECKER}:83-87`, `${PRIVACY}`],
    evidence: tail(r.stdout, 4),
  });
}
{
  const dir = makeSandbox("s7-garbage-plist", DIST_INPUTS);
  mutate(dir, PRIVACY, () => "NSPrivacyAccessedAPITypes");
  const r = runDistChecker(dir);
  record({
    id: "S7e",
    title:
      "PrivacyInfo.xcprivacy replaced by the bare string 'NSPrivacyAccessedAPITypes' (not a plist)",
    rule: "a privacy manifest that is not a plist fails at build/upload; the Linux gate should reject it",
    expected: "exit 1",
    observed: `exit ${r.status}`,
    files: [`${DIST_CHECKER}:83-87`],
    evidence: tail(r.stdout, 4),
  });
}

// ---------------------------------------------------------------------------
// S5 — store-copy rules over ENTER: lines and mobile .tsx string literals.
const FORBIDDEN =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+%\s*accura|\bbest\b|ai coach/i;
{
  const dossier = readFileSync(join(repoRoot, "docs/APP_STORE_SUBMISSION.md"), "utf8").split("\n");
  const enterHits = dossier
    .map((l, i) => ({ line: i + 1, text: l }))
    .filter((x) => x.text.includes("ENTER:") && FORBIDDEN.test(x.text.replace(/`ENTER:`/g, "")));
  record({
    id: "S5a",
    title: "docs/APP_STORE_SUBMISSION.md ENTER: lines vs forbidden-term list",
    rule: "APP_STORE_SUBMISSION.md §0 rules 4–5: no Android/Google Play/guest mode/Live Court/DUPR/competitors/accuracy %/best in store metadata",
    expected: "0 hits",
    observed: `${enterHits.length} hits`,
    files: ["docs/APP_STORE_SUBMISSION.md"],
    evidence: enterHits.map((h) => `${h.line}: ${h.text.slice(0, 160)}`).join("\n") || "(none)",
    extra: { enterLineCount: dossier.filter((l) => l.includes("ENTER:")).length },
  });
}
{
  // String literals only: '...', "...", `...` and JSX text between > and <.
  // Comments are stripped first so doc comments mentioning Android don't count.
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) {
        if (e === "__tests__" || e === "node_modules") continue;
        walk(p);
      } else if (p.endsWith(".tsx")) files.push(p);
    }
  })(join(repoRoot, "apps/mobile/src"));
  const hits = [];
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    let inBlockComment = false;
    let androidGateLine = -Infinity;
    lines.forEach((line, i) => {
      const t = line.trim();
      if (inBlockComment) {
        if (t.includes("*/")) inBlockComment = false;
        return;
      }
      if (t.startsWith("/*") || t.startsWith("/**")) {
        if (!t.includes("*/")) inBlockComment = true;
        return;
      }
      if (t.startsWith("//") || t.startsWith("*") || /^import\b/.test(t) || /\bfrom\s+['"]/.test(t))
        return;
      if (/Platform\.OS\s*===\s*['"]android['"]/.test(line)) androidGateLine = i;
      const literals = [
        ...line.matchAll(/'((?:[^'\\]|\\.)*)'/g),
        ...line.matchAll(/"((?:[^"\\]|\\.)*)"/g),
        ...line.matchAll(/`((?:[^`\\]|\\.)*)`/g),
        ...line.matchAll(/>\s*([^<>{}]+?)\s*</g),
      ].map((m) => m[1]);
      // JSX text lines (no tag on the line) — plain prose inside <Text>…</Text>
      if (!/[<>{}=;]/.test(line) && /^\s*[A-Za-z(≈]/.test(line)) literals.push(t);
      for (const raw of literals) {
        const lit = raw.trim();
        if (!FORBIDDEN.test(lit)) continue;
        if (/^[\w./$-]+,?$/.test(lit)) continue; // identifiers, testIDs, import paths, platform keys
        if (/^\$\{/.test(lit)) continue; // pure template expressions
        const category = /dupr/i.test(lit)
          ? "dupr"
          : /android|google play/i.test(lit)
            ? i - androidGateLine <= 6
              ? "android_gated_by_Platform.OS"
              : "android_ungated"
            : /\bbest\b/i.test(lit)
              ? /personal best|best (score|streak)|previous best/i.test(lit)
                ? "best_personal_stat_label"
                : "best_claim"
              : "other";
        hits.push({
          file: relative(repoRoot, f),
          line: i + 1,
          literal: lit.slice(0, 120),
          category,
        });
      }
    });
  }
  // Runtime-generated copy: the DUPR estimate formatter every rating surface renders.
  const duprSrc = readFileSync(join(repoRoot, "apps/mobile/src/progress/duprEstimate.ts"), "utf8");
  const duprLiteral = duprSrc.match(/`\(≈ DUPR[^`]*`/)?.[0] ?? null;
  const duprNote = duprSrc.match(/DUPR_ESTIMATE_NOTE =\s*\n?\s*'([^']*)'/)?.[1] ?? null;
  if (duprLiteral)
    hits.push({
      file: "apps/mobile/src/progress/duprEstimate.ts",
      line: 26,
      literal: duprLiteral,
      category: "dupr",
    });
  if (duprNote)
    hits.push({
      file: "apps/mobile/src/progress/duprEstimate.ts",
      line: 31,
      literal: duprNote,
      category: "dupr",
    });
  const violating = hits.filter((h) =>
    ["dupr", "android_ungated", "best_claim", "other"].includes(h.category),
  );
  const byCat = {};
  for (const h of hits) byCat[h.category] = (byCat[h.category] ?? 0) + 1;
  record({
    id: "S5b",
    title:
      "apps/mobile/src/**/*.tsx string literals + JSX text vs forbidden-term list (comments/imports/identifiers excluded, __tests__ excluded)",
    rule: "task rule: user-facing copy must follow APP_STORE_SUBMISSION.md (no Android/Google Play/guest mode/Live Court/DUPR/competitors; no accuracy %, superlatives, AI-coach equivalence)",
    expected: "0 violating literals (categories dupr / android_ungated / best_claim / other)",
    observed: `${violating.length} violating literals; all categories: ${JSON.stringify(byCat)}`,
    files: [...new Set(violating.map((h) => `${h.file}:${h.line}`))],
    evidence: hits.map((h) => `[${h.category}] ${h.file}:${h.line}  ${h.literal}`).join("\n"),
    extra: { tsxFilesScanned: files.length, hits },
  });
}

// ---------------------------------------------------------------------------
// S8 — version triple vs apps/mobile/package.json (release-verification skill
// step 4 prints it and says "All must agree").
{
  const pkg = JSON.parse(readFileSync(join(repoRoot, "apps/mobile/package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(repoRoot, MANIFEST), "utf8"));
  const dir = makeSandbox("s8-pkg-version", [...RELEASE_INPUTS, "apps/mobile/package.json"]);
  mutate(dir, "apps/mobile/package.json", (s) =>
    s.replace(/"version": "[^"]+"/, '"version": "9.9.9"'),
  );
  const r = runChecker(dir);
  record({
    id: "S8",
    title: `apps/mobile/package.json version (${pkg.version}) vs manifest marketingVersion (${manifest.versionScheme.marketingVersion}); checker with package.json=9.9.9`,
    rule: ".agents/skills/release-verification/SKILL.md step 4: pbxproj, package.json, manifest, runtimeConfig 'All must agree with each other'",
    expected: `package.json version == ${manifest.versionScheme.marketingVersion} at HEAD and checker exit 1 when it disagrees`,
    observed: `HEAD package.json version = ${pkg.version}; checker exit ${r.status} with 9.9.9`,
    files: [
      "apps/mobile/package.json:3",
      ".agents/skills/release-verification/SKILL.md:36-43",
      `${CHECKER}:35-71`,
    ],
    evidence: tail(r.stdout, 3),
  });
}

// ---------------------------------------------------------------------------
// S9 — release docs: every backtick-quoted repo path must exist.
{
  const docs = [
    "docs/APP_STORE_SUBMISSION.md",
    "docs/PRELAUNCH_CHECKLIST.md",
    "docs/RELEASE_OPERATIONS.md",
    "docs/RELEASE_PLAN_V1.md",
    "docs/DISTRIBUTION.md",
    ".agents/skills/release-verification/SKILL.md",
  ];
  const dangling = [];
  for (const d of docs) {
    const text = readFileSync(join(repoRoot, d), "utf8");
    for (const m of text.matchAll(
      /`((?:apps|docs|infra|tools|scripts|supabase|packages|services|native|ml|datasets|\.github|\.agents)\/[A-Za-z0-9_./-]+)`/g,
    )) {
      const p = m[1].replace(/[.,;:]+$/, "");
      if (/[*<>{}$]/.test(p)) continue; // globs / placeholders
      if (!existsSync(join(repoRoot, p))) dangling.push(`${d}: ${p}`);
    }
  }
  record({
    id: "S9",
    title: "backtick-quoted repo paths referenced by the release docs exist",
    rule: "release docs are the human runbook; a dangling path is an unexecutable step",
    expected: "0 dangling",
    observed: `${dangling.length} dangling`,
    files: docs,
    evidence: dangling.join("\n") || "(none)",
  });
}

// ---------------------------------------------------------------------------
const broken = results.filter((r) => r.verdict === "BROKEN");
const report = {
  tool: "attack-release-config-docs",
  commit: run("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).stdout.trim(),
  seed,
  node: process.version,
  sandboxRoot,
  scenarios: results.length,
  broken: broken.length,
  held: results.length - broken.length,
  results,
};
if (jsonOut) {
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify(report, null, 2));
}
console.log(
  `\n${results.length} scenarios: ${report.held} HELD, ${broken.length} BROKEN (seed ${seed}; sandbox ${sandboxRoot})`,
);
if (jsonOut) console.log(`report: ${jsonOut}`);
process.exit(broken.length > 0 ? 1 : 0);
