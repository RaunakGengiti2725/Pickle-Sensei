// Executable route-parity probe: sends every `METHOD /v1/...` the mobile app
// references (from an archmap `routes-matrix.json`) through the REAL edge
// function handler (supabase/functions/api/index.ts, loaded via the existing
// black-box harness with Supabase/RevenueCat stubbed at the fetch layer) and
// records the HTTP status each one gets from the production router.
//
// "Not routed" = the router's own 404 (`Unknown endpoint: METHOD /path`).
// Any other outcome — including a resource 404 with an error `code`
// (drill.not_found, session.not_found) — means the route exists and got as
// far as validation/auth/data; the probe judges routing, not behaviour.
//
// When the static extractor could not resolve the client's HTTP method
// (`UNKNOWN`), the probe tries the methods the edge router declares for that
// path (from the same matrix); if the edge declares none, all four verbs.
//
// Run from the repo root (uses the __wf__ import map so `postgres`/@std
// resolve exactly as the edge tests do):
//
//   deno run -A --no-check --config supabase/functions/api/__wf__/deno.json \
//     tools/archmap/edge/mobile_route_probe.ts <routes-matrix.json> <out.json>
//
// Exit code: 0 when every mobile route is routed, 1 when at least one is a
// 404, 2 on usage error. Deterministic: fixed user id, fixed IP per request
// (no rate-limit sharing across probes), no wall-clock in the JSON.

import {
  loadHarness,
  TEST_USER_ID,
  userRequest,
} from "../../../supabase/functions/api/__wf__/routesHarness.ts";

interface MobileCall {
  methods: string[];
  where: string[];
}

interface EdgeRoute {
  method: string;
  path: string;
}

interface RoutesMatrix {
  mobileClientCalls: Record<string, MobileCall>;
  edge: { routes: EdgeRoute[] };
}

interface ProbeRow {
  method: string;
  path: string;
  probedPath: string;
  status: number;
  routed: boolean;
  methodSource: "client" | "edge-declared" | "all-verbs";
  bodyPreview: string;
  where: string[];
}

const [matrixPath, outPath] = Deno.args;
if (!matrixPath || !outPath) {
  console.error("usage: mobile_route_probe.ts <routes-matrix.json> <out.json>");
  Deno.exit(2);
}

const matrix = JSON.parse(await Deno.readTextFile(matrixPath)) as RoutesMatrix;
const harness = await loadHarness();

// Minimal rows so auth + access checks have something to read; the probe is
// about the router, so any non-404 status is a "routed" verdict.
harness.tables["accounts"] = [{ id: TEST_USER_ID, canonical_app_user_id: TEST_USER_ID }];
harness.tables["access_state"] = [{ premium: false, scored_count: 0, reserved_count: 0 }];

const PARAM_ID = "33333333-3333-4333-8333-333333333333";

const rows: ProbeRow[] = [];
let ipCounter = 1;
const entries = Object.entries(matrix.mobileClientCalls).sort(([a], [b]) => (a < b ? -1 : 1));
for (const [path, call] of entries) {
  let methods = call.methods.filter((m) => m !== "UNKNOWN");
  let methodSource: ProbeRow["methodSource"] = "client";
  if (methods.length === 0) {
    methods = matrix.edge.routes.filter((r) => r.path === path).map((r) => r.method);
    methodSource = "edge-declared";
    if (methods.length === 0) {
      methods = ["GET", "POST", "PUT", "DELETE"];
      methodSource = "all-verbs";
    }
  }
  for (const method of methods) {
    const probedPath = path.replaceAll(":param", PARAM_ID);
    const ip = `198.51.100.${ipCounter++}`;
    const body = method === "GET" ? undefined : {};
    let status = -1;
    let bodyPreview = "";
    try {
      const res = await harness.handler(userRequest(method, probedPath, { ip, body }));
      status = res.status;
      bodyPreview = (await res.text()).slice(0, 200);
    } catch (error) {
      bodyPreview = `handler threw: ${error instanceof Error ? error.message : String(error)}`;
    }
    rows.push({
      method,
      path,
      probedPath,
      status,
      routed: !(status === 404 && bodyPreview.includes("Unknown endpoint")),
      methodSource,
      bodyPreview,
      where: call.where,
    });
  }
}

// For all-verbs probes the path is routed if ANY verb is; report the
// unrouted verbs only when none matched.
const allVerbPaths = new Set(rows.filter((r) => r.methodSource === "all-verbs").map((r) => r.path));
const unrouted = rows.filter((r) => {
  if (r.routed) return false;
  if (!allVerbPaths.has(r.path)) return true;
  return !rows.some((o) => o.path === r.path && o.routed);
});
const out = {
  handler: "supabase/functions/api/index.ts",
  harness: "supabase/functions/api/__wf__/routesHarness.ts",
  probedRoutes: rows.length,
  unrouted: unrouted.length,
  rows,
};
await Deno.writeTextFile(outPath, JSON.stringify(out, null, 2) + "\n");
const report = rows.map((r) => {
  const mark = unrouted.includes(r) ? "   <-- NOT ROUTED" : "";
  return `${String(r.status).padStart(3)} ${r.method.padEnd(6)} ${r.path} [${r.methodSource}]${mark}`;
});
report.push(`probed=${rows.length} unrouted=${unrouted.length} → ${outPath}`);
await Deno.stdout.write(new TextEncoder().encode(report.join("\n") + "\n"));
Deno.exit(unrouted.length ? 1 : 0);
