#!/usr/bin/env node
// Build a per-test outcome matrix across several runs (one run per seed) and
// list every test whose outcome changes between runs.
//
//   node tools/determinism/matrix-report.mjs [--table] jest   seed-A.json seed-B.json ...
//   node tools/determinism/matrix-report.mjs [--table] junit  seed-A.xml  seed-B.xml  ...
//   node tools/determinism/matrix-report.mjs [--table] vitest seed-A/ seed-B/ ...   (dirs of per-package vitest json)
//
// The seed is read from the file/dir name (`seed-<n>`), else the basename is used.
// Output (JSON): {kind, runs:[{seed,file,totals}], totalTests, unstable:[{id, outcomes:{seed:status}}],
//                 onlyInSome:[{id, presentIn:[seeds]}], stable:boolean}
// Exit 0 when `unstable` and `onlyInSome` are both empty, 1 otherwise, 2 usage.
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const table = argv.includes("--table");
const rest = argv.filter((a) => a !== "--table");
const kind = rest.shift();
const inputs = rest;
if (!["jest", "junit", "vitest"].includes(kind) || inputs.length < 2) {
  console.error("usage: matrix-report.mjs [--table] jest|junit|vitest <run1> <run2> [...]");
  process.exit(2);
}

// Absolute suite paths are reported relative to the repo root (PICKLE_REPO, else the git toplevel of cwd).
const repoRoot = (process.env.PICKLE_REPO ?? gitToplevel()).replace(/\/+$/, "");
function gitToplevel() {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : process.cwd();
}

const seedOf = (p) => {
  const m = basename(p.replace(/\/+$/, "")).match(/seed-?(\w+)/);
  return m ? m[1] : basename(p);
};

// -> Map<testId, status>  status in passed|failed|skipped|todo
function fromJestJson(file, prefix = "") {
  const r = JSON.parse(readFileSync(file, "utf8"));
  const out = new Map();
  const totals = {
    passed: r.numPassedTests ?? 0,
    failed: r.numFailedTests ?? 0,
    skipped: (r.numPendingTests ?? 0) + (r.numTodoTests ?? 0),
    suitesFailed: r.numFailedTestSuites ?? 0,
    runtimeErrorSuites: r.numRuntimeErrorTestSuites ?? 0,
  };
  for (const suite of r.testResults ?? []) {
    const rel = suite.name.startsWith(repoRoot + "/")
      ? suite.name.slice(repoRoot.length + 1)
      : suite.name;
    if (suite.status === "failed" && (suite.assertionResults ?? []).length === 0) {
      out.set(`${prefix}${rel} :: <suite failed to run>`, "failed");
    }
    for (const a of suite.assertionResults ?? []) {
      const st =
        a.status === "pending" || a.status === "todo" || a.status === "skipped"
          ? "skipped"
          : a.status;
      out.set(`${prefix}${rel} :: ${a.fullName}`, st);
    }
  }
  return { tests: out, totals };
}

function fromJunit(file) {
  const xml = readFileSync(file, "utf8");
  const out = new Map();
  const totals = { passed: 0, failed: 0, skipped: 0 };
  const unesc = (s) =>
    s
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const body = m[3] ?? "";
    const name = unesc((attrs.match(/\bname="([^"]*)"/) ?? [])[1] ?? "?");
    const cls = unesc((attrs.match(/\bclassname="([^"]*)"/) ?? [])[1] ?? "");
    let st = "passed";
    if (/<failure\b|<error\b/.test(body)) st = "failed";
    else if (/<skipped\b/.test(body)) st = "skipped";
    totals[st]++;
    out.set(`${cls} :: ${name}`, st);
  }
  return { tests: out, totals };
}

function fromVitestDir(dir) {
  const out = new Map();
  const totals = { passed: 0, failed: 0, skipped: 0, suitesFailed: 0, runtimeErrorSuites: 0 };
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const pkg = f.replace(/\.json$/, "");
    const r = fromJestJson(join(dir, f), `${pkg} :: `);
    for (const [k, v] of r.tests) out.set(k, v);
    for (const k of Object.keys(totals)) totals[k] += r.totals[k] ?? 0;
  }
  return { tests: out, totals };
}

const runs = inputs.map((p) => {
  const seed = seedOf(p);
  const parsed =
    kind === "jest" ? fromJestJson(p) : kind === "junit" ? fromJunit(p) : fromVitestDir(p);
  return { seed, file: p, totals: parsed.totals, tests: parsed.tests };
});

const ids = new Set();
for (const r of runs) for (const id of r.tests.keys()) ids.add(id);

const unstable = [];
const onlyInSome = [];
for (const id of [...ids].sort()) {
  const outcomes = {};
  const presentIn = [];
  for (const r of runs) {
    if (r.tests.has(id)) {
      outcomes[r.seed] = r.tests.get(id);
      presentIn.push(r.seed);
    }
  }
  if (presentIn.length !== runs.length) onlyInSome.push({ id, presentIn });
  const vals = [...new Set(Object.values(outcomes))];
  if (vals.length > 1) unstable.push({ id, outcomes });
}
const failedEverywhere = [...ids]
  .filter((id) => runs.every((r) => r.tests.get(id) === "failed"))
  .sort();

const stable = unstable.length === 0 && onlyInSome.length === 0;
const report = {
  kind,
  runs: runs.map(({ seed, file, totals }) => ({ seed, file, totals })),
  totalTests: ids.size,
  unstable,
  onlyInSome,
  failedEverywhere,
  stable,
};

if (table) {
  console.log(`${kind}: ${runs.length} runs, ${ids.size} distinct tests`);
  for (const r of runs) console.log(`  seed ${r.seed}: ${JSON.stringify(r.totals)}`);
  console.log(`  unstable (outcome differs by seed): ${unstable.length}`);
  for (const u of unstable) console.log(`    ${u.id}  ${JSON.stringify(u.outcomes)}`);
  console.log(`  present only in some runs: ${onlyInSome.length}`);
  for (const o of onlyInSome) console.log(`    ${o.id}  present in seeds ${o.presentIn.join(",")}`);
  console.log(`  failed in every run: ${failedEverywhere.length}`);
  for (const f of failedEverywhere) console.log(`    ${f}`);
  console.log(`  stable: ${stable}`);
} else {
  console.log(JSON.stringify(report, null, 2));
}
process.exit(stable ? 0 : 1);
