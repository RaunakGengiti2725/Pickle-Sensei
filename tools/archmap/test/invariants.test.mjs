import { test } from "node:test";
import assert from "node:assert/strict";
import { packageEdges, crossCheckRouteProbe } from "../lib/invariants.mjs";

function modelWith(nodes, imports) {
  return { workspaces: { nodes }, imports };
}

test("packageEdges: devDependencies and test/type-only imports are excluded from the runtime graph", () => {
  const model = modelWith(
    {
      "@pickle/a": {
        dir: "packages/a",
        workspaceDeps: { "@pickle/b": "workspace:*", "@pickle/c": "workspace:*" },
        workspaceDepKinds: { "@pickle/b": "dependencies", "@pickle/c": "devDependencies" },
      },
      "@pickle/b": { dir: "packages/b", workspaceDeps: {}, workspaceDepKinds: {} },
      "@pickle/c": { dir: "packages/c", workspaceDeps: {}, workspaceDepKinds: {} },
    },
    {
      "@pickle/a": {
        imports: {
          "@pickle/b": ["packages/a/src/x.ts:1"],
          "@pickle/c": ["packages/a/test/x.test.ts:1"],
        },
        runtimeImports: { "@pickle/b": ["packages/a/src/x.ts:1"] },
      },
      "@pickle/b": { imports: {}, runtimeImports: {} },
      "@pickle/c": { imports: {}, runtimeImports: {} },
    },
  );
  const e = packageEdges(model);
  assert.deepEqual([...e.declared.get("@pickle/a")].sort(), ["@pickle/b", "@pickle/c"]);
  assert.deepEqual([...e.declaredRuntime.get("@pickle/a")], ["@pickle/b"]);
  assert.deepEqual([...e.observed.get("@pickle/a")].sort(), ["@pickle/b", "@pickle/c"]);
  assert.deepEqual([...e.observedRuntime.get("@pickle/a")], ["@pickle/b"]);
});

const staticModel = (missing) => ({
  invariants: [{ id: "ROUTE-01", details: missing.map((m) => ({ mobileCalls: m })) }],
});

test("ROUTE-03: passes when probe and static verdict agree", () => {
  const probe = {
    rows: [
      {
        method: "POST",
        path: "/v1/drill-completions",
        routed: false,
        methodSource: "client",
        status: 404,
        bodyPreview: "Unknown endpoint",
      },
      {
        method: "GET",
        path: "/v1/me",
        routed: true,
        methodSource: "client",
        status: 503,
        bodyPreview: "",
      },
      {
        method: "POST",
        path: "/v1/auth/logout",
        routed: true,
        methodSource: "edge-declared",
        status: 503,
        bodyPreview: "",
      },
    ],
  };
  const r = crossCheckRouteProbe(staticModel(["POST /v1/drill-completions"]), probe);
  assert.equal(r.status, "pass");
  assert.deepEqual(r.replay.confirmedUnrouted, ["POST /v1/drill-completions"]);
  assert.equal(r.replay.probedRoutes, 3);
});

test("ROUTE-03: fails when the probe finds an unrouted client call the static pass called served", () => {
  const probe = {
    rows: [
      {
        method: "GET",
        path: "/v1/me",
        routed: false,
        methodSource: "client",
        status: 404,
        bodyPreview: "Unknown endpoint: GET /v1/me.",
      },
    ],
  };
  const r = crossCheckRouteProbe(staticModel([]), probe);
  assert.equal(r.status, "fail");
  assert.deepEqual(r.details, [
    {
      probeUnrouted: "GET /v1/me",
      status: 404,
      bodyPreview: "Unknown endpoint: GET /v1/me.",
      staticVerdict: "served",
    },
  ]);
});

test("ROUTE-03: fails when a statically-missing route was observed routed or never probed", () => {
  const probe = {
    rows: [
      {
        method: "POST",
        path: "/v1/x",
        routed: true,
        methodSource: "client",
        status: 400,
        bodyPreview: "",
      },
    ],
  };
  const r = crossCheckRouteProbe(staticModel(["POST /v1/x", "POST /v1/y"]), probe);
  assert.equal(r.status, "fail");
  assert.deepEqual(r.details, [
    { staticMissing: "POST /v1/x", probeVerdict: "routed" },
    { staticMissing: "POST /v1/y", probeVerdict: "not probed" },
  ]);
});

test("ROUTE-03: guessed-method unrouted rows are info, malformed rows fail", () => {
  const probe = {
    rows: [
      {
        method: "PUT",
        path: "/v1/guess",
        routed: false,
        methodSource: "all-verbs",
        status: 404,
        bodyPreview: "Unknown endpoint",
      },
      { method: "GET", path: "/v1/bad" },
    ],
  };
  const r = crossCheckRouteProbe(staticModel([]), probe);
  assert.equal(r.status, "fail");
  assert.equal(r.details.length, 1);
  assert.ok("malformedProbeRow" in r.details[0]);
  assert.deepEqual(r.info, [
    {
      probeUnrouted: "PUT /v1/guess",
      methodSource: "all-verbs",
      note: "method guessed by probe, not by the client source",
    },
  ]);
});
