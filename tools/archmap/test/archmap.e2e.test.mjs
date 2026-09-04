// End-to-end: run the harness against THIS repository twice and pin the
// contract the coordinator relies on — deterministic bytes, every output file
// present and parseable, replay metadata on every invariant, and the CLI exit
// codes. Reads the repo; writes only under a temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildModel, writeOutputs, REPO_ROOT } from "../archmap.mjs";

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "archmap-e2e-"));
const CLI = path.join(REPO_ROOT, "tools/archmap/archmap.mjs");

test("buildModel is deterministic and every invariant carries replay metadata", () => {
  const a = JSON.stringify(buildModel(REPO_ROOT));
  const b = JSON.stringify(buildModel(REPO_ROOT));
  assert.equal(a, b, "two extractions of the same tree must be byte-identical");
  const model = JSON.parse(a);
  assert.ok(model.invariants.length >= 25);
  for (const c of model.invariants) {
    assert.match(c.id, /^[A-Z]+-\d\d$/);
    assert.ok(["pass", "fail", "info"].includes(c.status), c.id);
    assert.equal(c.replay.command, "node tools/archmap/archmap.mjs --check");
    assert.equal(c.replay.focus, c.id);
    assert.ok(Array.isArray(c.details) && Array.isArray(c.info), c.id);
  }
  const ids = model.invariants.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "invariant ids are unique");
});

test("model facts the architecture map depends on (repo-specific pins)", () => {
  const model = buildModel(REPO_ROOT);
  const nodes = model.workspaces.nodes;
  assert.equal(nodes.PickleSensei.manager, "npm");
  assert.equal(
    nodes.PickleSensei.workspaceExcluded,
    true,
    "apps/mobile is excluded from pnpm-workspace.yaml",
  );
  assert.equal(nodes["@pickle/api"].kind, "service");
  assert.ok(model.routes.edge.routes.length >= 20, "edge fn route table extracted");
  assert.ok(model.routes.legacy.length >= 50, "fastify route table extracted");
  assert.ok(
    Object.keys(model.routes.mobileClientCalls).length >= 20,
    "mobile client calls extracted",
  );
  assert.ok(model.workflows[".github/workflows/mac-full-verify.yml"].selfHosted);
  assert.ok(model.workflows[".github/workflows/mac-smoke-test.yml"].selfHosted);
  assert.equal(model.workflows[".github/workflows/ci.yml"].selfHosted, false);
  assert.ok(model.featureFlags.flags.length > 0 && model.featureFlags.seedKeys.length > 0);
  assert.ok(model.native.swiftTargets.length >= 3);
  assert.ok(
    model.migrations.supabase.files.length > 0 &&
      model.migrations.legacyNodeDatabase.files.length > 0,
  );
  assert.ok(model.staleOrDuplicateSystems.some((s) => s.id === "services-api-vs-edge-fn"));
  assert.ok(
    model.staleOrDuplicateSystems.some((s) => s.id === "mac-smoke-test-vs-mac-full-verify"),
  );
});

test("writeOutputs emits every documented file; JSON parses; Mermaid has a graph header", () => {
  const model = buildModel(REPO_ROOT);
  const dir = path.join(OUT, "w");
  const files = writeOutputs(model, dir, {
    gitSha: "test",
    gitDirty: false,
    generatedAt: "t",
    node: process.version,
    iterations: [],
  });
  const names = files.map((f) => path.basename(f)).sort();
  assert.deepEqual(names, [
    "ARCHITECTURE.md",
    "archmap.json",
    "critical-paths.mmd",
    "env-matrix.json",
    "invariants.json",
    "packages.mmd",
    "routes-matrix.json",
    "runtime.mmd",
    "stale-systems.json",
    "workflows.mmd",
  ]);
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    if (f.endsWith(".json")) JSON.parse(text);
    if (f.endsWith(".mmd")) assert.match(text.split("\n")[0], /^(graph|flowchart) /, f);
  }
  const md = fs.readFileSync(path.join(dir, "ARCHITECTURE.md"), "utf8");
  assert.match(md, /## Route matrix/);
  assert.match(md, /services-api-vs-edge-fn/);
});

test("CLI: --repeat records heap/timing per iteration; --check exit code reflects failing invariants", () => {
  const dir = path.join(OUT, "cli");
  const r = spawnSync(
    process.execPath,
    [CLI, "--out", dir, "--repeat", "3", "--check", "--quiet"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "archmap.json"), "utf8")).meta;
  assert.equal(meta.repeat, 3);
  assert.equal(meta.iterations.length, 3);
  for (const it of meta.iterations) {
    assert.ok(Number.isInteger(it.ms) && it.ms >= 0);
    assert.ok(it.heap.heapUsed > 0 && it.heap.rss > 0);
    assert.ok(it.bytes > 10000);
    assert.equal(it.identicalToFirst, true);
  }
  assert.equal(meta.deterministic, true);
  const inv = JSON.parse(fs.readFileSync(path.join(dir, "invariants.json"), "utf8"));
  const failing = inv.filter((c) => c.status === "fail").length;
  assert.equal(
    r.status,
    failing > 0 ? 1 : 0,
    `exit ${r.status} with ${failing} failing invariants\n${r.stderr}`,
  );
});

test("CLI: --probe merges a probe file and adds ROUTE-03", () => {
  const dir = path.join(OUT, "probe");
  const probePath = path.join(OUT, "probe.json");
  fs.writeFileSync(probePath, JSON.stringify({ rows: [] }));
  spawnSync(process.execPath, [CLI, "--out", dir, "--probe", probePath, "--quiet"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const inv = JSON.parse(fs.readFileSync(path.join(dir, "invariants.json"), "utf8"));
  const r3 = inv.find((c) => c.id === "ROUTE-03");
  assert.ok(r3, "ROUTE-03 present when --probe given");
  assert.equal(r3.replay.probedRoutes, 0);
  const r1 = inv.find((c) => c.id === "ROUTE-01");
  // An empty probe cannot confirm anything, so ROUTE-03 fails exactly when ROUTE-01 has failures.
  assert.equal(r3.status, r1.details.length ? "fail" : "pass");
});
