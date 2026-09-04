#!/usr/bin/env node
/**
 * PRELAUNCH_CHECKLIST walk — turns docs/PRELAUNCH_CHECKLIST.md into a table
 * where EVERY item carries exactly one of:
 *
 *   verified   — executed on this checkout; evidence = command + exit + artifact
 *   human-only — needs a human / console / credential / physical device
 *   BLOCKED    — a plane this role may not touch (hosted Supabase, ASC, Mac)
 *
 * A ✅ in the checklist is a code-state assertion, NOT execution evidence; it
 * is ignored here. Statuses come from a companion JSON keyed by the item's
 * line number (see prelaunch-status.<sha>.json) so the walk is replayable and
 * diff-able. The script also re-runs the cheap static probes the statuses
 * cite, so the log carries their raw output.
 *
 * Exit 1 if any checklist item is missing a status, or a status is not one of
 * the three labels, or the status file was written for a different checklist
 * (item text drifted). Exit 0 otherwise — which is a COMPLETE WALK, not a GO.
 *
 * Usage: node tools/release/xc-readiness/prelaunch-walk.mjs --status <json> [--json out.json] [--md out.md]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const statusPath = argValue("--status");
if (!statusPath) {
  console.error("usage: prelaunch-walk.mjs --status <status.json> [--json out] [--md out]");
  process.exit(2);
}
const jsonOut = argValue("--json");
const mdOut = argValue("--md");
const LABELS = new Set(["verified", "human-only", "BLOCKED"]);

const lines = readFileSync(join(repoRoot, "docs/PRELAUNCH_CHECKLIST.md"), "utf8").split("\n");
const status = JSON.parse(readFileSync(statusPath, "utf8"));

// --- parse items -------------------------------------------------------------
const items = [];
let section = null;
for (let i = 0; i < lines.length; i += 1) {
  const l = lines[i];
  const h = /^## (.+)$/.exec(l);
  if (h) section = h[1];
  const m = /^- (✅|☐) (.*)$/.exec(l);
  if (!m) continue;
  let text = m[2];
  for (let j = i + 1; j < lines.length && /^\s{2}\S/.test(lines[j]); j += 1)
    text += ` ${lines[j].trim()}`;
  items.push({
    line: i + 1,
    section,
    checklistMark: m[1] === "✅" ? "code-state ✅" : "manual ☐",
    text,
  });
}

// --- cheap static probes cited by the statuses --------------------------------
const run = (cmd, cmdArgs) => {
  try {
    return {
      cmd: [cmd, ...cmdArgs].join(" "),
      exit: 0,
      out: execFileSync(cmd, cmdArgs, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch (err) {
    return {
      cmd: [cmd, ...cmdArgs].join(" "),
      exit: err.status ?? 1,
      out: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim(),
    };
  }
};
const probes = {
  gitignore_env: run("git", ["check-ignore", "-v", ".env", ".env.local", "supabase/.temp/x"]),
  gitignore_env_gap: run("git", [
    "check-ignore",
    "-v",
    ".env.production",
    ".env.staging",
    ".env.development",
    "apps/mobile/.env.production",
  ]),
  tracked_env_files: run("bash", ["-c", "git ls-files | grep -E '(^|/)\\.env' || echo '(none)'"]),
  storage_buckets_in_migrations: run("grep", ["-rn", "storage.buckets", "supabase/migrations"]),
  admin_routes: run("grep", ["-n", "/admin", "supabase/functions/api/index.ts"]),
  card_columns_in_migrations: run("grep", [
    "-rniE",
    "card_number|\\bpan\\b|\\bcvv\\b",
    "supabase/migrations",
  ]),
  analytics_sdks_in_mobile_deps: run("grep", [
    "-iE",
    "sentry|crashlytics|bugsnag|firebase|amplitude|segment|mixpanel",
    "apps/mobile/package.json",
  ]),
  live_court_screen: run("bash", [
    "-c",
    'ls apps/mobile/src/screens | grep -i live || echo "(no Live Court screen)"',
  ]),
  revenuecat_ios_key_prefix: run("node", [
    "-e",
    "const t=require('fs').readFileSync('apps/mobile/src/config/runtimeConfig.ts','utf8');const m=/REVENUECAT_IOS_PUBLIC_SDK_KEY: string \\| null =\\s*'([a-z]+)_/.exec(t);console.log(m?m[1]+'_':'(no key)')",
  ]),
};

// --- merge -------------------------------------------------------------------
const problems = [];
const rows = items.map((it) => {
  const s = status.items[String(it.line)];
  if (!s) {
    problems.push(`line ${it.line}: no status entry`);
    return { ...it, status: "MISSING", evidence: "" };
  }
  if (!LABELS.has(s.status)) problems.push(`line ${it.line}: invalid status "${s.status}"`);
  return { ...it, status: s.status, evidence: s.evidence };
});
for (const key of Object.keys(status.items)) {
  if (!items.some((it) => String(it.line) === key))
    problems.push(
      `status entry for line ${key} does not match a checklist item (checklist drifted?)`,
    );
}

const counts = { verified: 0, "human-only": 0, BLOCKED: 0, MISSING: 0 };
for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
const bySection = {};
for (const r of rows) {
  bySection[r.section] ??= { verified: 0, "human-only": 0, BLOCKED: 0, MISSING: 0 };
  bySection[r.section][r.status] += 1;
}

let gitSha = "unknown";
try {
  gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
} catch {
  /* ignore */
}

const report = {
  tool: "xc-readiness/prelaunch-walk",
  gitSha,
  statusFile: statusPath,
  statusGitSha: status.gitSha,
  generatedAt: new Date().toISOString(),
  totals: counts,
  bySection,
  items: rows,
  probes,
  problems,
  note: "A complete walk (exit 0) means every item is labelled; it is not a GO. BLOCKED and human-only items are not passes.",
};
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));

const md = [
  `# PRELAUNCH_CHECKLIST walk @ ${gitSha}`,
  "",
  `Totals: verified ${counts.verified} · human-only ${counts["human-only"]} · BLOCKED ${counts.BLOCKED}${counts.MISSING ? ` · MISSING ${counts.MISSING}` : ""}`,
  "",
  "| § | line | mark | status | item | evidence / minimum action |",
  "|---|---|---|---|---|---|",
  ...rows.map(
    (r) =>
      `| ${r.section} | ${r.line} | ${r.checklistMark} | **${r.status}** | ${r.text.replace(/\|/g, "\\|").slice(0, 160)} | ${r.evidence.replace(/\|/g, "\\|")} |`,
  ),
  "",
  "## Static probes",
  "",
  ...Object.entries(probes).flatMap(([k, p]) => [
    `### ${k}`,
    "",
    "```",
    `$ ${p.cmd}`,
    p.out || "(no output)",
    `exit=${p.exit}`,
    "```",
    "",
  ]),
];
if (mdOut) writeFileSync(mdOut, md.join("\n"));

console.log(
  `checklist items: ${rows.length}; verified ${counts.verified}, human-only ${counts["human-only"]}, BLOCKED ${counts.BLOCKED}, missing ${counts.MISSING}`,
);
for (const [sec, c] of Object.entries(bySection))
  console.log(
    `  ${sec}: verified ${c.verified} / human-only ${c["human-only"]} / BLOCKED ${c.BLOCKED}${c.MISSING ? ` / MISSING ${c.MISSING}` : ""}`,
  );
for (const [k, p] of Object.entries(probes))
  console.log(`probe ${k}: exit=${p.exit} ${p.out.split("\n").length} line(s)`);
if (status.gitSha && status.gitSha !== gitSha)
  console.log(`note: status file was written for ${status.gitSha}, checkout is ${gitSha}`);
for (const p of problems) console.log(`PROBLEM: ${p}`);
process.exit(problems.length ? 1 : 0);
