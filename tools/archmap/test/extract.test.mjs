// Extractor tests against small synthetic repos written to a temp dir, so each
// regex/heuristic is pinned by the exact source shapes it must (and must not)
// match. No fixture reads the real repo — see archmap.test.mjs for that.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractEdgeRoutes,
  extractMobileClientCalls,
  normalizeClientPath,
  parseWorkflow,
  extractScripts,
  extractFeatureFlags,
  extractNativeBridges,
  extractArtifacts,
  importSpecifiers,
  isRuntimeSourceFile,
  conditionalSkipsIn,
} from "../lib/extract.mjs";
import { spawnSync } from "node:child_process";

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archmap-fixture-"));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

test("normalizeClientPath: path params → :param, suffix/query interpolation dropped", () => {
  assert.equal(
    normalizeClientPath("/v1/x/${encodeURIComponent(id)}/finalize"),
    "/v1/x/:param/finalize",
  );
  assert.equal(normalizeClientPath("/v1/catalog/drills${query}"), "/v1/catalog/drills");
  assert.equal(normalizeClientPath("/v1/me?foo=1"), "/v1/me");
  assert.equal(normalizeClientPath("/v1/shots:sync"), "/v1/shots:sync");
});

test("extractEdgeRoutes: switch-case, regex handlers with PUT||DELETE guards, path equality", () => {
  const root = fixture({
    "supabase/functions/api/index.ts": `
      switch (route) {
        case "GET /v1/me":
        case "POST /v1/shots:sync":
          break;
      }
      if (request.method === "PUT" || request.method === "DELETE") {
        const m = /^\\/v1\\/me\\/saved-drills\\/([^/]+)$/.exec(path);
      }
      if (request.method === "POST") {
        const f = /^\\/v1\\/sessions\\/([^/]+)\\/finalize$/.exec(path);
      }
      if (request.method === "GET" && path === "/v1/training-plans/current") {}
    `,
  });
  const { routes } = extractEdgeRoutes(root);
  const keys = routes.map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(keys, [
    "GET /v1/me",
    "DELETE /v1/me/saved-drills/:param",
    "PUT /v1/me/saved-drills/:param",
    "POST /v1/sessions/:param/finalize",
    "POST /v1/shots:sync",
    "GET /v1/training-plans/current",
  ]);
  assert.deepEqual(routes[0].where, ["supabase/functions/api/index.ts:3"]);
});

test("extractMobileClientCalls: method from adjacent arg (either order) or fetch init; UNKNOWN otherwise", () => {
  const root = fixture({
    "apps/mobile/src/a.ts": `
      request('POST', '/v1/training-plans');
      request('/v1/billing/sync', 'POST');
      request('PUT', \`/v1/me/saved-drills/\${encodeURIComponent(slug)}\`);
      fetchFn(\`\${session.apiBaseUrl}/v1/rank\`, { headers, method: 'GET' });
      const url = \`\${base}/v1/me/access\`;
    `,
    "apps/mobile/src/__tests__/ignored.test.ts": `request('DELETE', '/v1/should-not-appear');`,
  });
  const calls = extractMobileClientCalls(root);
  assert.deepEqual(Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, v.methods])), {
    "/v1/billing/sync": ["POST"],
    "/v1/me/access": ["UNKNOWN"],
    "/v1/me/saved-drills/:param": ["PUT"],
    "/v1/rank": ["GET"],
    "/v1/training-plans": ["POST"],
  });
  assert.deepEqual(calls["/v1/rank"].where, ["apps/mobile/src/a.ts:5"]);
});

test("parseWorkflow: triggers, permissions, self-hosted only from runs-on, inline run lines", () => {
  const wf = `name: Mac
on:
  workflow_dispatch:
  push:
    branches: [main, "ci/mac-**"]
permissions:
  contents: read
concurrency:
  group: mac-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  verify:
    runs-on: [self-hosted, macOS, ARM64]
    steps:
      - run: scripts/mac-full-verify.sh
      - run: |
          sw_vers
          xcodebuild -version
`;
  const parsed = parseWorkflow(wf, ".github/workflows/x.yml");
  assert.equal(parsed.name, "Mac");
  assert.ok(parsed.triggers.includes("push") && parsed.triggers.includes("workflow_dispatch"));
  assert.deepEqual(parsed.permissions, ["contents: read"]);
  assert.equal(parsed.selfHosted, true);
  assert.equal(parsed.cancelInProgress, "true");
  assert.equal(parsed.inlineRunLines, 3);
  assert.deepEqual(
    parsed.jobs.verify.scriptRefs.map((r) => r.path),
    ["scripts/mac-full-verify.sh"],
  );

  const cloud = parseWorkflow(
    `name: CI\non: [pull_request]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "mentions self-hosted in a string only"\n`,
    ".github/workflows/ci.yml",
  );
  assert.equal(
    cloud.selfHosted,
    false,
    "a self-hosted mention outside runs-on must not classify the workflow",
  );
});

test("extractScripts: `|| true` is failure-masking only around verdict-bearing commands", () => {
  const root = fixture({
    "scripts/gate.sh": `#!/usr/bin/env bash
set -euo pipefail
# comment mentioning || true is prose
echo "node: $(node --version 2>/dev/null || true)"
{ grep -v noise out.log || true; }
key="$(platform_key || true)"
[ -n "$key" ] || die "unsupported"
docker rm -f "$c" >/dev/null 2>&1 || true
pnpm -r test || true
xcodebuild test -scheme X || true
`,
    "scripts/orchestrator.sh": `#!/usr/bin/env bash
set -uo pipefail
stage_e2e() { :; }
stage_db() { :; }
ALL_STAGES=(e2e db)
`,
  });
  const scripts = extractScripts(root);
  assert.deepEqual(scripts["scripts/gate.sh"].orTrueLines, [9, 10]);
  assert.deepEqual(scripts["scripts/gate.sh"].orTrueBenignLines, [4, 5, 6, 8]);
  assert.equal(scripts["scripts/gate.sh"].errexit, true);
  const orch = scripts["scripts/orchestrator.sh"];
  assert.equal(orch.errexit, false);
  assert.equal(orch.usesPipefail, true);
  assert.deepEqual(orch.stageFunctions, ["e2e", "db"]);
  assert.deepEqual(orch.stageArrays.ALL_STAGES, ["e2e", "db"]);
});

test("extractFeatureFlags: registry flag() calls and tuple-array seed keys", () => {
  const root = fixture({
    "services/api/src/modules/flags/registry.ts": `
      flag("alpha_thing", "desc", true, false),
      flag("beta_thing", "desc", false, true),
    `,
    "packages/database/src/seed.ts": `
      export const SEEDED_FEATURE_FLAGS: Array<[string, string, boolean]> = [
        ["alpha_thing", "desc", true],
        ["beta_thing", "desc", false],
      ];
      const other = [["not_a_flag", "x", true]];
    `,
  });
  const flags = extractFeatureFlags(root);
  assert.deepEqual(
    flags.flags.map((f) => f.key),
    ["alpha_thing", "beta_thing"],
  );
  assert.deepEqual(flags.seedKeys, ["alpha_thing", "beta_thing"]);
  assert.deepEqual(flags.killSwitchEnvVars, ["FLAG_KILL_BETA_THING"]);
});

test("extractNativeBridges: NativeModules.X and requireNativeComponent (literal or const) only", () => {
  const root = fixture({
    "apps/mobile/src/camera/capture.ts": `
      const native = NativeModules.PickleVideoCapture;
      emitter.addListener('PickleCameraEvent', onEvent);
      const VIEW = 'PicklePreviewView';
      const Preview = requireNativeComponent<Props>(VIEW);
      const Overlay = requireNativeComponent('PickleOverlayView');
    `,
    "apps/mobile/ios/LocalPods/PickleNative/Sources/Bridge.m": `
      RCT_EXTERN_MODULE(PickleVideoCapture, RCTEventEmitter)
      RCT_EXTERN_MODULE(PicklePreviewViewManager, RCTViewManager)
    `,
  });
  const bridges = extractNativeBridges(root);
  const js = Object.keys(bridges)
    .filter((n) => bridges[n].js.length > 0)
    .sort();
  assert.deepEqual(js, ["PickleOverlayView", "PicklePreviewView", "PickleVideoCapture"]);
  assert.ok(!("PickleCameraEvent" in bridges), "event names are not modules");
  assert.deepEqual(bridges.PickleVideoCapture.ios, [
    "apps/mobile/ios/LocalPods/PickleNative/Sources/Bridge.m:2",
  ]);
  assert.deepEqual(bridges.PicklePreviewViewManager.js, []);
});

test("importSpecifiers: static, dynamic, require and re-exports; flags type-only imports", () => {
  const specs = importSpecifiers(`
    import a from "@pickle/a";
    import type { T } from "@pickle/type-only";
    export { b } from "./b.js";
    const c = await import("@pickle/c");
    const d = require("@pickle/d");
  `);
  assert.deepEqual(specs.map((s) => [s.spec, s.typeOnly]).sort(), [
    ["./b.js", false],
    ["@pickle/a", false],
    ["@pickle/c", false],
    ["@pickle/d", false],
    ["@pickle/type-only", true],
  ]);
});

test("isRuntimeSourceFile: test/eval/bench/fixture paths are not runtime", () => {
  assert.equal(isRuntimeSourceFile("src/index.ts"), true);
  assert.equal(isRuntimeSourceFile("src/regression/benches.ts"), true);
  assert.equal(isRuntimeSourceFile("test/x.test.ts"), false);
  assert.equal(isRuntimeSourceFile("src/__tests__/x.ts"), false);
  assert.equal(isRuntimeSourceFile("eval/scoring.eval.ts"), false);
  assert.equal(isRuntimeSourceFile("src/foo.spec.tsx"), false);
});

test("extractArtifacts: gitignore status comes from git check-ignore, writers from scripts/workflows", () => {
  const root = fixture({
    ".gitignore": "artifacts/\n",
    "scripts/a.sh": "OUT=artifacts/run\nMAC=${MAC_ARTIFACTS:-macos-ci-artifacts}\n",
    ".github/workflows/w.yml": "      path: macos-ci-artifacts/\n",
  });
  spawnSync("git", ["-C", root, "init", "-q"]);
  const a = extractArtifacts(root);
  assert.equal(a.artifactRootsGitignored.artifacts.gitignored, true);
  assert.equal(a.artifactRootsGitignored["macos-ci-artifacts"].gitignored, false);
  assert.deepEqual(a.artifactRootsGitignored["macos-ci-artifacts"].writtenBy, [
    ".github/workflows/w.yml:1",
    "scripts/a.sh:2",
  ]);
  assert.deepEqual(a.artifactRootsGitignored["apps/mobile/artifacts"].writtenBy, []);
  assert.equal(a.releaseManifest, null);
});

test("conditionalSkipsIn: classifies skipIf/alias/deno guards and flags fs gates on untracked paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archmap-skips-"));
  spawnSync("git", ["-C", dir, "init", "-q"]);
  fs.mkdirSync(path.join(dir, "datasets/tracked"), { recursive: true });
  fs.writeFileSync(path.join(dir, "datasets/tracked/a.json"), "{}");
  fs.writeFileSync(path.join(dir, ".gitignore"), "datasets/runs/\n");
  spawnSync("git", ["-C", dir, "add", "datasets/tracked/a.json", ".gitignore"]);
  const text = [
    "const testUrl = process.env.DATABASE_URL_TEST;",
    'describe.skipIf(!testUrl)("db", () => {});',
    'const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;',
    'describe.skipIf(!hasFfmpeg || flaky(1, 2))("ff", () => {});',
    'const RUN_DIR = join(__dirname, "..", "datasets", "runs", "x");',
    'const present = existsSync(join(RUN_DIR, "pose.json"));',
    "const d = present ? describe : describe.skip;",
    'const OK_DIR = join(__dirname, "..", "datasets", "tracked");',
    "const ok = existsSync(OK_DIR);",
    "const e = ok ? describe : describe.skip;",
    "// ignore: true).",
    "const skip = !(await dockerAvailable());",
    "Deno.test({ name: 'x', ignore: skip, fn() {} });",
  ].join("\n");
  const rel = "test/a.test.ts";
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  const out = conditionalSkipsIn(dir, rel, text);
  assert.deepEqual(
    out.map((c) => [c.where.split(":")[1], c.kind, c.guard, c.guardExpr]),
    [
      ["2", "skipIf", "env", "!testUrl"],
      ["4", "skipIf", "command", "!hasFfmpeg || flaky(1, 2)"],
      ["7", "alias", "fs", "present"],
      ["10", "alias", "fs", "ok"],
      ["13", "denoIgnore", "command", "skip"],
    ],
  );
  // Both fs-gated aliases see every path literal in the file; only the untracked one is reported.
  assert.deepEqual(out[2].fsGatedUntracked, [{ path: "datasets/runs/x", gitignored: true }]);
  assert.deepEqual(out[3].fsGatedUntracked, [{ path: "datasets/runs/x", gitignored: true }]);
});
