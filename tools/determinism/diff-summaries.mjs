#!/usr/bin/env node
// Diff two or more verify-cloud summary.json files by stage.
//
//   node tools/determinism/diff-summaries.mjs [--table] run-1/summary.json run-2/summary.json [...]
//
// Default output: JSON {runs, stages:[{name, statuses, seconds, stable, spreadSeconds, spreadPct}], stableStatuses}
// --table: human-readable table on stdout.
// Exit 0 when every stage has the same status in every run, 1 otherwise, 2 on usage error.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const table = args.includes("--table");
const files = args.filter((a) => a !== "--table");
if (files.length < 2) {
  console.error("usage: diff-summaries.mjs [--table] a/summary.json b/summary.json [...]");
  process.exit(2);
}

const runs = files.map((f) => {
  const s = JSON.parse(readFileSync(f, "utf8"));
  return {
    file: f,
    git_sha: s.git_sha,
    dirty: s.dirty,
    tier: s.tier,
    ok: s.ok,
    started_utc: s.started_utc,
    stages: s.stages,
  };
});

const names = [];
for (const r of runs) for (const st of r.stages) if (!names.includes(st.name)) names.push(st.name);

const stages = names.map((name) => {
  const per = runs.map((r) => r.stages.find((s) => s.name === name) ?? null);
  const statuses = per.map((s) => (s ? s.status : "absent"));
  const seconds = per.map((s) => (s ? s.seconds : null));
  const notes = per.map((s) => (s ? s.note : null));
  const stable = statuses.every((s) => s === statuses[0]);
  const nums = seconds.filter((x) => typeof x === "number");
  const min = nums.length ? Math.min(...nums) : null;
  const max = nums.length ? Math.max(...nums) : null;
  const spreadSeconds = min === null ? null : max - min;
  const spreadPct =
    min === null || max === 0 ? null : Math.round(((max - min) / Math.max(max, 1)) * 1000) / 10;
  return { name, statuses, seconds, notes, stable, spreadSeconds, spreadPct };
});

const stableStatuses = stages.every((s) => s.stable);
const sameSha = runs.every((r) => r.git_sha === runs[0].git_sha);
const allClean = runs.every((r) => r.dirty === false);

if (table) {
  const w = Math.max(...names.map((n) => n.length), 5);
  const hdr = [
    "STAGE".padEnd(w),
    ...runs.map((_, i) => `run-${i + 1}`.padEnd(20)),
    "spread(s)",
    "stable",
  ].join("  ");
  console.log(
    `git_sha: ${runs.map((r) => r.git_sha.slice(0, 8)).join(" / ")}  dirty: ${runs.map((r) => r.dirty).join("/")}  ok: ${runs.map((r) => r.ok).join("/")}`,
  );
  console.log(hdr);
  for (const s of stages) {
    const cells = s.statuses.map((st, i) => `${st} ${s.seconds[i] ?? "-"}s`.padEnd(20));
    console.log(
      [
        s.name.padEnd(w),
        ...cells,
        String(s.spreadSeconds ?? "-").padStart(9),
        s.stable ? "yes" : "NO",
      ].join("  "),
    );
  }
  console.log(`stable statuses: ${stableStatuses}  same sha: ${sameSha}  all clean: ${allClean}`);
} else {
  console.log(JSON.stringify({ runs, stages, stableStatuses, sameSha, allClean }, null, 2));
}
process.exit(stableStatuses ? 0 : 1);
