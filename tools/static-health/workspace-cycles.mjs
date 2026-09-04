#!/usr/bin/env node
// Package-manifest-level cycle detection for the pnpm workspace.
//
// pnpm only prints "WARN There are cyclic workspace dependencies" during
// `pnpm install`; this reproduces the check deterministically (Tarjan SCC over
// workspace:* edges) so it can run as a pure read-only census and be pinned by
// a test. Edges are reported per field so a devDependencies-only cycle (test
// coupling) is distinguishable from a dependencies cycle (runtime coupling).
//
// Usage: node tools/static-health/workspace-cycles.mjs [--out file.json] [--runtime-only]
import fs from "node:fs";
import path from "node:path";
import { loadWorkspacePackages } from "./lib/repo.mjs";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
const runtimeOnly = args.includes("--runtime-only");

export function buildWorkspaceGraph(packages, { runtimeOnly = false } = {}) {
  const names = new Set(packages.map((p) => p.name));
  const edges = [];
  for (const p of packages) {
    const fields = runtimeOnly
      ? [["dependencies", p.dependencies]]
      : [
          ["dependencies", p.dependencies],
          ["devDependencies", p.devDependencies],
          ["optionalDependencies", p.optionalDependencies],
        ];
    for (const [field, list] of fields) {
      for (const d of list) {
        if (names.has(d.name) && d.spec.startsWith("workspace:"))
          edges.push({ from: p.name, to: d.name, field });
      }
    }
  }
  return { nodes: [...names].sort(), edges };
}

export function stronglyConnectedComponents(nodes, edges) {
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const e of edges) adj.get(e.from).push(e.to);
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const idx = new Map();
  const low = new Map();
  const sccs = [];
  const visit = (v) => {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v)) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      sccs.push(comp.sort());
    }
  };
  for (const n of nodes) if (!idx.has(n)) visit(n);
  const selfLoops = new Set(edges.filter((e) => e.from === e.to).map((e) => e.from));
  return sccs.filter((c) => c.length > 1 || selfLoops.has(c[0]));
}

export function analyzeWorkspaceCycles(packages) {
  const full = buildWorkspaceGraph(packages);
  const runtime = buildWorkspaceGraph(packages, { runtimeOnly: true });
  const fullCycles = stronglyConnectedComponents(full.nodes, full.edges);
  const runtimeCycles = stronglyConnectedComponents(runtime.nodes, runtime.edges);
  const describe = (cycle, edges) => ({
    packages: cycle,
    edges: edges.filter((e) => cycle.includes(e.from) && cycle.includes(e.to)),
  });
  return {
    generatedAt: new Date().toISOString(),
    packages: full.nodes.length,
    edges: full.edges.length,
    runtimeEdges: runtime.edges.length,
    cyclesIncludingDev: fullCycles.map((c) => describe(c, full.edges)),
    cyclesRuntimeOnly: runtimeCycles.map((c) => describe(c, runtime.edges)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = analyzeWorkspaceCycles(loadWorkspacePackages());
  if (runtimeOnly) result.cyclesIncludingDev = undefined;
  const json = JSON.stringify(result, null, 2);
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, json);
  }
  console.log(json);
}
