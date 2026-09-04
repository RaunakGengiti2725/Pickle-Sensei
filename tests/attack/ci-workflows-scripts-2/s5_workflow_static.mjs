#!/usr/bin/env node
// Scenario 5 (static — no Mac run, no ci/mac-* push) plus workflow hygiene.
//
// Pushing twice to a ci/mac-* branch is forbidden for this role, so the
// cancel-in-progress behaviour is asserted from the workflow definition:
//   * concurrency.group is scoped per ref and cancel-in-progress is true
//   * the step-summary and upload-artifact steps run `if: always()` (GitHub runs
//     always() steps for cancelled jobs, so partial artifacts + summary appear)
//   * permissions stay `contents: read`; mac workflows carry no pull_request
//     trigger; the ci-gate job checks every `needs` result.
// Every verdict names file:line so the reader can check it without trusting us.
//
// Usage: node tests/attack/ci-workflows-scripts-2/s5_workflow_static.mjs [out dir]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const out = process.argv[2] || process.env.ATTACK_OUT || path.join(process.env.HOME, "attack-artifacts", "s5");
fs.mkdirSync(out, { recursive: true });

// js-yaml is a transitive workspace dependency (pnpm store); resolve it without
// adding a package.json entry to this attack harness.
const require = createRequire(import.meta.url);
function loadYamlLib() {
  try {
    return require("js-yaml");
  } catch {
    const store = path.join(root, "node_modules", ".pnpm");
    const hit = fs.readdirSync(store).find((d) => d.startsWith("js-yaml@"));
    if (!hit) throw new Error("js-yaml not found in node_modules/.pnpm");
    return require(path.join(store, hit, "node_modules", "js-yaml"));
  }
}
const yaml = loadYamlLib();

const verdicts = [];
function verdict(id, status, observed, expected, evidence) {
  verdicts.push({ id, status, observed, expected, evidence });
  console.log(`[attack] ${id} → ${status}: ${observed}`);
}
function lineOf(file, needle) {
  const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes(needle));
  return i >= 0 ? `${file}:${i + 1}` : `${file}:?`;
}
function load(file) {
  return yaml.load(fs.readFileSync(path.join(root, file), "utf8"));
}

const MAC = ".github/workflows/mac-full-verify.yml";
const SMOKE = ".github/workflows/mac-smoke-test.yml";
const CI = ".github/workflows/ci.yml";
const mac = load(MAC);
const smoke = load(SMOKE);
const ci = load(CI);
let broken = 0;

// --- concurrency: per-ref group, cancel-in-progress
{
  const c = mac.concurrency || {};
  const perRef = typeof c.group === "string" && c.group.includes("${{ github.ref }}");
  if (perRef && c["cancel-in-progress"] === true) {
    verdict("s5-concurrency", "HELD",
      `concurrency.group='${c.group}' (per ref) with cancel-in-progress: true — a second push to the same ci/mac-* ref cancels the in-flight run; different refs do not cancel each other`,
      "per-ref cancel-in-progress", [lineOf(MAC, "group:"), lineOf(MAC, "cancel-in-progress")]);
  } else {
    broken++;
    verdict("s5-concurrency", "BROKEN", `concurrency=${JSON.stringify(c)}`, "per-ref group + cancel-in-progress: true", [lineOf(MAC, "concurrency")]);
  }
}

// --- always() on step summary + artifact upload
{
  const job = mac.jobs["mac-full-verify"];
  const steps = job.steps;
  const summary = steps.find((s) => s.name === "Step summary");
  const upload = steps.find((s) => typeof s.uses === "string" && s.uses.startsWith("actions/upload-artifact@"));
  const okSummary = summary && String(summary.if).replace(/\s/g, "") === "always()";
  const okUpload = upload && String(upload.if).replace(/\s/g, "") === "always()" && upload.with && upload.with.path === "macos-ci-artifacts/";
  const ifNoFiles = upload && upload.with && upload.with["if-no-files-found"];
  if (okSummary && okUpload) {
    verdict("s5-always-steps", "HELD",
      `'Step summary' and upload-artifact both carry if: always() (GitHub evaluates always() as true for cancelled jobs — docs: "always: … even when canceled"); upload path macos-ci-artifacts/, if-no-files-found: ${ifNoFiles}`,
      "summary + artifact steps run on cancel/failure", [lineOf(MAC, "Step summary"), lineOf(MAC, "upload-artifact")]);
  } else {
    broken++;
    verdict("s5-always-steps", "BROKEN", `summary.if=${summary && summary.if} upload.if=${upload && upload.if}`, "if: always() on both", [lineOf(MAC, "Step summary")]);
  }
  // The step summary only cats files that exist; on cancellation summary.json is
  // written by the orchestrator at the END, so it will be absent (see s1 cancel test).
  const run = String(summary.run);
  const guarded = run.includes('[ -f "$MAC_ARTIFACTS/summary.json" ]') && run.includes("swift-native-xcresult-summary.txt") && run.includes("launch-summary.txt");
  verdict("s5-summary-content", guarded ? "HELD" : "BROKEN",
    guarded ? "step summary guards each file with [ -f … ] so a cancelled run (no summary.json yet) still produces a summary with sw_vers/xcodebuild -version and whatever partial files exist" : "step summary unguarded",
    "no failing step summary on partial artifacts", [lineOf(MAC, "summary.json")]);
  if (!guarded) broken++;
  // workflow-level timeout vs the 1–2 h run
  verdict("s5-timeout", job["timeout-minutes"] >= 120 ? "HELD" : "BROKEN",
    `timeout-minutes: ${job["timeout-minutes"]} for a 1–2 h run`, ">= 120", [lineOf(MAC, "timeout-minutes")]);
}

// --- permissions: contents: read everywhere (REVIEW.md:114)
for (const [file, wf] of [[MAC, mac], [CI, ci], [SMOKE, smoke]]) {
  const p = wf.permissions;
  const ok = p && Object.keys(p).length === 1 && p.contents === "read";
  if (ok) {
    verdict(`s5-permissions-${path.basename(file, ".yml")}`, "HELD", "permissions: { contents: read }", "contents: read only", [lineOf(file, "permissions")]);
  } else {
    broken++;
    verdict(`s5-permissions-${path.basename(file, ".yml")}`, "BROKEN",
      `no workflow-level 'permissions:' block (permissions=${JSON.stringify(p)}) — the job runs with the repository's DEFAULT GITHUB_TOKEN permissions on the personal self-hosted Mac`,
      "permissions: contents: read (REVIEW.md:114 'must stay contents: read')", [`${file}:1`, "REVIEW.md:114"]);
  }
}

// --- no pull_request trigger on anything that lands on the self-hosted runner
for (const [file, wf] of [[MAC, mac], [SMOKE, smoke]]) {
  const on = wf.on || wf[true]; // js-yaml parses bare `on:` as boolean true
  const triggers = on && typeof on === "object" ? Object.keys(on) : [String(on)];
  const bad = triggers.filter((t) => t.startsWith("pull_request"));
  if (bad.length === 0) {
    verdict(`s5-no-pr-trigger-${path.basename(file, ".yml")}`, "HELD", `triggers: ${triggers.join(", ")}`, "no pull_request", [`${file}:${lineOf(file, "on:").split(":")[1]}`]);
  } else {
    broken++;
    verdict(`s5-no-pr-trigger-${path.basename(file, ".yml")}`, "BROKEN", `pull_request trigger present: ${bad}`, "none", [lineOf(file, "pull_request")]);
  }
}
{
  // branches for push must be main + ci/mac-** only
  const on = mac.on || mac[true];
  const branches = (on.push && on.push.branches) || [];
  const ok = JSON.stringify(branches) === JSON.stringify(["main", "ci/mac-**"]);
  verdict("s5-push-branches", ok ? "HELD" : "BROKEN", `push.branches=${JSON.stringify(branches)}`, '["main","ci/mac-**"]', [lineOf(MAC, "branches:")]);
  if (!ok) broken++;
}

// --- self-hosted runner labels
for (const [file, wf, jobName] of [[MAC, mac, "mac-full-verify"], [SMOKE, smoke, "mac-test"]]) {
  const labels = wf.jobs[jobName]["runs-on"];
  const ok = JSON.stringify(labels) === JSON.stringify(["self-hosted", "macOS", "ARM64"]);
  verdict(`s5-runner-labels-${path.basename(file, ".yml")}`, ok ? "HELD" : "BROKEN", `runs-on=${JSON.stringify(labels)}`, '["self-hosted","macOS","ARM64"]', [lineOf(file, "runs-on")]);
  if (!ok) broken++;
}

// --- mac-smoke-test has no concurrency guard (one physical runner)
{
  const ok = !!smoke.concurrency;
  verdict("s5-smoke-concurrency", ok ? "HELD" : "INFO",
    ok ? `concurrency=${JSON.stringify(smoke.concurrency)}` : "mac-smoke-test.yml has no concurrency block; a single runner instance still executes one job at a time, so a dispatched smoke test queues behind (not alongside) a full verify — no failure mode, documented for completeness",
    "n/a", [`${SMOKE}:1`]);
}

// --- ci-gate: always() + every needs result must be success
{
  const gate = ci.jobs["ci-gate"];
  const run = String(gate.steps[0].run);
  const checksAll = run.includes('select(.value.result != "success")') && run.includes("exit 1");
  const needs = gate.needs;
  const expected = ["verify", "mobile", "edge", "supabase-security"];
  const needsOk = JSON.stringify([...needs].sort()) === JSON.stringify([...expected].sort());
  const ok = String(gate.if).replace(/\s/g, "") === "always()" && checksAll && needsOk;
  verdict("s5-ci-gate", ok ? "HELD" : "BROKEN",
    ok ? `ci-gate: if always(), needs=${JSON.stringify(needs)}, fails when any result != success (skipped/cancelled count as failure)` : `if=${gate.if} needs=${JSON.stringify(needs)} checksAll=${checksAll}`,
    "one gate that is red on any non-success", [lineOf(CI, "ci-gate:"), lineOf(CI, 'select(.value.result != "success")')]);
  if (!ok) broken++;
}

// --- every CI job uploads artifacts with if: always()
{
  const missing = [];
  for (const [name, job] of Object.entries(ci.jobs)) {
    if (name === "ci-gate" || name === "containers") continue;
    const up = (job.steps || []).find((s) => typeof s.uses === "string" && s.uses.startsWith("actions/upload-artifact@"));
    if (!up || String(up.if).replace(/\s/g, "") !== "always()") missing.push(name);
  }
  verdict("s5-ci-artifacts-always", missing.length === 0 ? "HELD" : "BROKEN",
    missing.length === 0 ? "verify, mobile, edge, supabase-security all upload artifacts/verify-cloud/ci/ with if: always()" : `jobs without always() upload: ${missing}`,
    "artifacts retained on failure", [lineOf(CI, "upload-artifact")]);
  if (missing.length) broken++;
}

// --- security job fetch-depth 0 ⇒ history scan walks every remote ref (see s8)
{
  const sec = ci.jobs["supabase-security"];
  const co = sec.steps.find((s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@"));
  const depth0 = co && co.with && co.with["fetch-depth"] === 0;
  verdict("s5-security-fetch-depth", depth0 ? "INFO" : "BROKEN",
    depth0
      ? "supabase-security checks out with fetch-depth: 0 (all history for ALL branches, per actions/checkout README — INFERRED); scripts/security-scan.sh --history then runs gitleaks git without --log-opts, i.e. `git log -p --all`-style over every fetched ref. Combined with s8-stray-ref this makes the PR gate depend on unrelated branches' contents"
      : `fetch-depth=${co && co.with && co.with["fetch-depth"]} — history scan would be shallow`,
    "history scan bounded to the commit under test (e.g. --log-opts HEAD or the PR's base..head range)", [lineOf(CI, "fetch-depth: 0"), "scripts/security-scan.sh (history scan invocation)"]);
}

// --- checkout action version drift (v7 in ci.yml, v4 in the mac workflows)
{
  const versions = new Set();
  for (const [file, wf] of [[MAC, mac], [CI, ci], [SMOKE, smoke]]) {
    for (const job of Object.values(wf.jobs)) for (const s of job.steps || []) {
      if (typeof s.uses === "string" && s.uses.startsWith("actions/checkout@")) versions.add(`${path.basename(file)}:${s.uses}`);
    }
  }
  const distinct = new Set([...versions].map((v) => v.split("@")[1]));
  verdict("s5-checkout-versions", distinct.size === 1 ? "HELD" : "INFO",
    `actions/checkout pins in use: ${[...versions].join(", ")}`, "one pinned major across workflows", [lineOf(MAC, "actions/checkout@"), lineOf(CI, "actions/checkout@")]);
}

fs.writeFileSync(path.join(out, "s5-workflow-static.json"), JSON.stringify(verdicts, null, 2));
console.log(`s5: ${verdicts.length} checks, ${broken} BROKEN → ${path.join(out, "s5-workflow-static.json")}`);
process.exit(broken ? 1 : 0);
