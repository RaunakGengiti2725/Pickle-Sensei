// node --test tools/static-health/test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkspaceGraph,
  stronglyConnectedComponents,
  analyzeWorkspaceCycles,
} from "../workspace-cycles.mjs";
import { loadWorkspacePackages } from "../lib/repo.mjs";

const pkg = (name, deps = {}, dev = {}) => ({
  name,
  dependencies: Object.entries(deps).map(([n, spec]) => ({ name: n, spec })),
  devDependencies: Object.entries(dev).map(([n, spec]) => ({ name: n, spec })),
  optionalDependencies: [],
});

test("buildWorkspaceGraph keeps only workspace:* edges between known packages", () => {
  const graph = buildWorkspaceGraph([
    pkg("a", { b: "workspace:*", zod: "^3" }),
    pkg("b", {}, { c: "workspace:^" }),
    pkg("c"),
  ]);
  assert.deepEqual(graph.nodes, ["a", "b", "c"]);
  assert.deepEqual(graph.edges, [
    { from: "a", to: "b", field: "dependencies" },
    { from: "b", to: "c", field: "devDependencies" },
  ]);
  assert.deepEqual(
    buildWorkspaceGraph([pkg("a", {}, { b: "workspace:*" }), pkg("b")], { runtimeOnly: true })
      .edges,
    [],
  );
});

test("stronglyConnectedComponents finds multi-node cycles and self loops only", () => {
  const nodes = ["a", "b", "c", "d", "e"];
  const edges = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "a" },
    { from: "c", to: "d" },
    { from: "e", to: "e" },
  ];
  assert.deepEqual(stronglyConnectedComponents(nodes, edges), [["e"], ["a", "b", "c"]].sort());
  assert.deepEqual(stronglyConnectedComponents(["x", "y"], [{ from: "x", to: "y" }]), []);
});

test("analyzeWorkspaceCycles separates dev-only cycles from runtime cycles", () => {
  const result = analyzeWorkspaceCycles([
    pkg("a", {}, { b: "workspace:*" }),
    pkg("b", {}, { a: "workspace:*" }),
    pkg("c", { d: "workspace:*" }),
    pkg("d", { c: "workspace:*" }),
  ]);
  assert.deepEqual(
    result.cyclesIncludingDev.map((c) => c.packages),
    [
      ["a", "b"],
      ["c", "d"],
    ].sort(),
  );
  assert.deepEqual(
    result.cyclesRuntimeOnly.map((c) => c.packages),
    [["c", "d"]],
  );
  assert.deepEqual(
    result.cyclesRuntimeOnly[0].edges.map((e) => e.field),
    ["dependencies", "dependencies"],
  );
});

test("repo invariant: no runtime (dependencies) cycle between workspace packages", () => {
  const result = analyzeWorkspaceCycles(loadWorkspacePackages());
  assert.deepEqual(
    result.cyclesRuntimeOnly,
    [],
    `runtime workspace cycles found: ${JSON.stringify(result.cyclesRuntimeOnly)}`,
  );
});
