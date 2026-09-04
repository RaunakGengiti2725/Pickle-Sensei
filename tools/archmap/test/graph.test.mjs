import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findCycles,
  dependentsOf,
  reachableFrom,
  singlePointsOfFailure,
  fanIn,
  edgesToList,
} from "../lib/graph.mjs";

const g = (obj) => new Map(Object.entries(obj).map(([k, v]) => [k, new Set(v)]));

test("findCycles: reports each SCC once, sorted, ignoring acyclic nodes", () => {
  const edges = g({ a: ["b"], b: ["c"], c: ["a", "d"], d: ["e"], e: [], x: ["y"], y: ["x"] });
  assert.deepEqual(findCycles(edges), [
    ["a", "b", "c"],
    ["x", "y"],
  ]);
});

test("findCycles: self-loop counts as a cycle; DAG has none", () => {
  assert.deepEqual(findCycles(g({ a: ["a"] })), [["a"]]);
  assert.deepEqual(findCycles(g({ a: ["b"], b: ["c"], c: [] })), []);
});

test("reachableFrom / dependentsOf are transitive and exclude the start node", () => {
  const edges = g({ app: ["lib1"], lib1: ["lib2"], lib2: ["lib3"], other: ["lib3"] });
  assert.deepEqual(reachableFrom(edges, "app"), ["lib1", "lib2", "lib3"]);
  assert.deepEqual(dependentsOf(edges, "lib3"), ["app", "lib1", "lib2", "other"]);
  assert.deepEqual(dependentsOf(edges, "app"), []);
});

test("singlePointsOfFailure: a node whose removal severs a root from downstream nodes", () => {
  //  root → hub → {leafA, leafB};  root → leafC
  const edges = g({
    root: ["hub", "leafC"],
    hub: ["leafA", "leafB"],
    leafA: [],
    leafB: [],
    leafC: [],
  });
  const spofs = singlePointsOfFailure(edges, ["root"]);
  assert.deepEqual(spofs, [{ node: "hub", roots: ["root"], severed: ["leafA", "leafB"] }]);
});

test("singlePointsOfFailure: redundant paths mean no SPOF", () => {
  const edges = g({ root: ["a", "b"], a: ["leaf"], b: ["leaf"], leaf: [] });
  assert.deepEqual(singlePointsOfFailure(edges, ["root"]), []);
});

test("fanIn sorts by count desc then name; edgesToList is sorted and flat", () => {
  const edges = g({ a: ["z", "y"], b: ["z"], c: ["z", "y"] });
  assert.deepEqual(fanIn(edges), [
    { node: "z", count: 3 },
    { node: "y", count: 2 },
  ]);
  assert.deepEqual(edgesToList(edges), [
    { from: "a", to: "y" },
    { from: "a", to: "z" },
    { from: "b", to: "z" },
    { from: "c", to: "y" },
    { from: "c", to: "z" },
  ]);
});
