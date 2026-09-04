#!/usr/bin/env node
// Pickle Sensei architecture map & dependency-graph harness.
//
//   node tools/archmap/archmap.mjs [--out DIR] [--check] [--repeat N] [--probe route-probe.json]
//
// Extracts every workspace package, native target, edge function module, route,
// env var, feature flag, workflow, script, migration, dataset and artifact from
// the repository on disk; evaluates the invariants in lib/invariants.mjs; and
// writes docs-ready JSON + Mermaid + markdown under --out (default
// artifacts/archmap/<utc-stamp>/). `--check` exits 1 when any invariant fails.
// `--repeat N` re-runs extraction N times and asserts byte-identical output
// (determinism), recording per-iteration heap numbers. `--probe FILE` merges
// the black-box result of edge/mobile_route_probe.ts (run through Deno against
// the real edge handler) and adds ROUTE-03, which cross-checks it against the
// static ROUTE-01 verdict.
//
// Zero third-party dependencies: runs with the repo's Node (>=20).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  extractWorkspaces,
  extractImportEdges,
  extractMobileAliases,
  extractNative,
  extractNativeBridges,
  extractEdgeFunction,
  extractEdgeRoutes,
  extractFastifyRoutes,
  extractMobileClientCalls,
  extractEnvVars,
  extractWorkflows,
  extractScripts,
  extractMigrations,
  extractDatasets,
  extractArtifacts,
  extractUnverifiable,
  extractFeatureFlags,
  extractMl,
} from "./lib/extract.mjs";
import { checkAll, crossCheckRouteProbe } from "./lib/invariants.mjs";
import {
  renderPackageGraph,
  renderRuntimeGraph,
  renderCriticalPaths,
  renderWorkflowGraph,
  renderEnvTable,
  renderRouteTable,
} from "./lib/mermaid.mjs";
import { readJson } from "./lib/fsutil.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

function parseArgs(argv) {
  const args = { out: null, check: false, repeat: 1, quiet: false, probe: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--probe") args.probe = argv[++i];
    else if (a === "--check") args.check = true;
    else if (a === "--repeat") args.repeat = Number(argv[++i]);
    else if (a === "--quiet") args.quiet = true;
    else if (a === "-h" || a === "--help") {
      process.stdout.write(
        fs
          .readFileSync(fileURLToPath(import.meta.url), "utf8")
          .split("\n")
          .slice(1, 18)
          .join("\n")
          .replace(/^\/\/ ?/gm, "") + "\n",
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(args.repeat) || args.repeat < 1)
    throw new Error("--repeat must be a positive integer");
  return args;
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Build the full model. Pure function of the repository contents (+ optional probe JSON). */
export function buildModel(repoRoot = REPO_ROOT, probe = null) {
  const workspaces = extractWorkspaces(repoRoot);
  const imports = extractImportEdges(repoRoot, workspaces);
  const model = {
    workspaces,
    imports,
    mobileAliases: extractMobileAliases(repoRoot),
    native: extractNative(repoRoot),
    nativeBridges: extractNativeBridges(repoRoot),
    edgeFunction: extractEdgeFunction(repoRoot),
    routes: {
      edge: extractEdgeRoutes(repoRoot),
      legacy: extractFastifyRoutes(repoRoot),
      mobileClientCalls: extractMobileClientCalls(repoRoot),
    },
    env: extractEnvVars(repoRoot),
    featureFlags: extractFeatureFlags(repoRoot),
    workflows: extractWorkflows(repoRoot),
    scripts: extractScripts(repoRoot),
    migrations: extractMigrations(repoRoot),
    datasets: extractDatasets(repoRoot),
    artifacts: extractArtifacts(repoRoot),
    unverifiable: extractUnverifiable(repoRoot),
    ml: extractMl(repoRoot),
    criticalPaths: readJson(path.join(HERE, "critical-paths.json")),
  };
  model.invariants = checkAll(model, repoRoot);
  if (probe) {
    model.routes.blackBoxProbe = probe;
    model.invariants.push(crossCheckRouteProbe(model, probe));
  }
  model.staleOrDuplicateSystems = staleSystems(model);
  model.summary = summarize(model);
  return model;
}

function staleSystems(model) {
  const edge = new Set(model.routes.edge.routes.map((r) => `${r.method} ${r.path}`));
  const legacy = new Set(model.routes.legacy.map((r) => `${r.method} ${r.path}`));
  const shared = [...edge].filter((r) => legacy.has(r)).sort();
  const legacyOnly = [...legacy].filter((r) => !edge.has(r)).sort();
  const edgeOnly = [...edge].filter((r) => !legacy.has(r)).sort();
  const smoke = model.workflows[".github/workflows/mac-smoke-test.yml"];
  const full = model.workflows[".github/workflows/mac-full-verify.yml"];
  return [
    {
      id: "services-api-vs-edge-fn",
      canonical:
        "supabase/functions/api (Deno edge fn) — the only backend apps/mobile calls (apps/mobile/src/config/runtimeConfig.ts API_BASE_URL)",
      stale:
        "services/api (Fastify) + services/media-worker + packages/database/migrations + docker-compose Postgres — local/admin-web only",
      routeOverlap: {
        shared: shared.length,
        legacyOnly: legacyOnly.length,
        edgeOnly: edgeOnly.length,
        sharedRoutes: shared,
        legacyOnlyRoutes: legacyOnly,
        edgeOnlyRoutes: edgeOnly,
      },
      stillVerifiedBy: [
        "scripts/verify-cloud.sh stage test (services/api vitest)",
        "stage db (@pickle/database migrate/seed)",
        "stage admin + e2e (full tier)",
      ],
      risk: "Two route tables and two migration trees drift independently; a fix landing in services/api does not reach production.",
    },
    {
      id: "mac-smoke-test-vs-mac-full-verify",
      canonical:
        ".github/workflows/mac-full-verify.yml → scripts/mac-full-verify.sh (stages: environment, swift-native, ios-app)",
      stale:
        ".github/workflows/mac-smoke-test.yml (workflow_dispatch only; inline sw_vers/xcodebuild/swift probes)",
      comparison:
        smoke && full
          ? {
              smoke: {
                triggers: smoke.triggers,
                permissions: smoke.permissions,
                concurrency: smoke.concurrencyGroup,
                inlineRunLines: smoke.inlineRunLines,
              },
              full: {
                triggers: full.triggers,
                permissions: full.permissions,
                concurrency: full.concurrencyGroup,
                inlineRunLines: full.inlineRunLines,
              },
            }
          : null,
      risk: "Duplicate manual entry point on the single M4 runner; no permissions block; not documented as canonical anywhere (AGENTS.md/REVIEW.md point at mac-full-verify).",
    },
    {
      id: "two-migration-trees",
      canonical: `supabase/migrations (${model.migrations.supabase.files.length} files, applied to the hosted project)`,
      stale: `packages/database/migrations (${model.migrations.legacyNodeDatabase.files.length} files, docker-compose Postgres for services/api)`,
      risk: "Schema truth is split; RLS matrix and edge tests only cover supabase/migrations.",
    },
    {
      id: "feature-flag-registry",
      canonical: "none — the shipping app has no remote flag reader",
      stale: `${model.featureFlags.registryFile} (${model.featureFlags.flags.length} flags) served by services/api GET /v1/flags only`,
      risk: "Kill switches (FLAG_KILL_*) cannot affect the shipped iOS app.",
    },
    {
      id: "env-templates",
      canonical: "Edge-fn secrets via `supabase secrets set` (documented in AGENTS.md)",
      stale:
        ".env.example documents services/api + docker-compose only (OIDC_*, S3_*, SQS_*, DEV_AUTH_SECRET)",
      risk: "Two unrelated secret inventories; ENV-02/ENV-03 invariants track drift.",
    },
  ];
}

function summarize(model) {
  const inv = model.invariants;
  const nodes = model.workspaces.nodes;
  return {
    packages: Object.keys(nodes).length,
    byKind: Object.values(nodes).reduce(
      (acc, n) => ((acc[n.kind] = (acc[n.kind] ?? 0) + 1), acc),
      {},
    ),
    swiftTargets: model.native.swiftTargets.length,
    pods: model.native.pods.length,
    edgeRoutes: model.routes.edge.routes.length,
    edgePublicRoutes: model.routes.edge.publicRoutes.length,
    legacyRoutes: model.routes.legacy.length,
    mobileDistinctPaths: Object.keys(model.routes.mobileClientCalls).length,
    envVars: Object.keys(model.env).length,
    secretLikeEnvVars: Object.values(model.env).filter((v) => v.isSecretLike).length,
    featureFlags: model.featureFlags.flags.length,
    workflows: Object.keys(model.workflows).length,
    scripts: Object.keys(model.scripts).length,
    supabaseMigrations: model.migrations.supabase.files.length,
    legacyMigrations: model.migrations.legacyNodeDatabase.files.length,
    datasetDirs: Object.keys(model.datasets.dirs).length,
    invariants: {
      total: inv.length,
      pass: inv.filter((c) => c.status === "pass").length,
      fail: inv.filter((c) => c.status === "fail").length,
      info: inv.filter((c) => c.status === "info").length,
      failing: inv
        .filter((c) => c.status === "fail")
        .map((c) => `${c.id} (${c.severity}, ${c.details.length})`),
    },
  };
}

function stableJson(v) {
  return JSON.stringify(v, null, 2) + "\n";
}

function renderReport(model, meta) {
  const s = model.summary;
  const lines = [
    "# Pickle Sensei — architecture map (generated)",
    "",
    `Commit: \`${meta.gitSha}\` (dirty=${meta.gitDirty}) · generated ${meta.generatedAt} · node ${meta.node}`,
    "",
    "## Inventory",
    "",
    `| Facet | Count |`,
    `|---|---|`,
    `| Workspace packages (pnpm) + apps/mobile (npm) | ${s.packages} (${Object.entries(s.byKind)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ")}) |`,
    `| Swift targets / CocoaPods local pods | ${s.swiftTargets} / ${s.pods} |`,
    `| Edge-fn /v1 routes (+ public) | ${s.edgeRoutes} (+${s.edgePublicRoutes}) |`,
    `| Legacy Fastify routes | ${s.legacyRoutes} |`,
    `| Distinct /v1 paths called by apps/mobile | ${s.mobileDistinctPaths} |`,
    `| Env vars (secret-like) | ${s.envVars} (${s.secretLikeEnvVars}) |`,
    `| Feature flags (registry) | ${s.featureFlags} |`,
    `| Workflows / shell entry points | ${s.workflows} / ${s.scripts} |`,
    `| Migrations: supabase / legacy | ${s.supabaseMigrations} / ${s.legacyMigrations} |`,
    `| Dataset dirs | ${s.datasetDirs} |`,
    "",
    "## Invariants",
    "",
    "| ID | Severity | Status | Title | Details |",
    "|---|---|---|---|---|",
    ...model.invariants.map(
      (c) =>
        `| ${c.id} | ${c.severity} | **${c.status}** | ${c.title} | ${c.details.length} fail / ${c.info.length} info |`,
    ),
    "",
    "### Failing invariant details",
    "",
    ...model.invariants
      .filter((c) => c.status === "fail")
      .flatMap((c) => [
        `#### ${c.id} — ${c.title}`,
        "",
        "```json",
        JSON.stringify(c.details, null, 2),
        "```",
        `Replay: \`${c.replay.command}\` (focus ${c.replay.focus})`,
        "",
      ]),
    "## Stale / duplicate systems",
    "",
    ...model.staleOrDuplicateSystems.flatMap((s) => [
      `### ${s.id}`,
      "",
      `- canonical: ${s.canonical}`,
      `- stale: ${s.stale}`,
      `- risk: ${s.risk}`,
      "",
    ]),
    "## Single points of failure (external)",
    "",
    ...model.criticalPaths.externalSinglePointsOfFailure.map(
      (s) => `- **${s.id}** — ${s.what} _(mitigation: ${s.mitigation})_`,
    ),
    "",
    "## Diagrams",
    "",
    "### Package graph",
    "",
    "```mermaid",
    renderPackageGraph(model),
    "```",
    "",
    "### Runtime systems",
    "",
    "```mermaid",
    renderRuntimeGraph(model),
    "```",
    "",
    "### Critical paths",
    "",
    "```mermaid",
    renderCriticalPaths(model),
    "```",
    "",
    "### Workflows → scripts → stages",
    "",
    "```mermaid",
    renderWorkflowGraph(model),
    "```",
    "",
    "## Route matrix",
    "",
    renderRouteTable(model),
    "",
    "## Environment variable matrix",
    "",
    renderEnvTable(model),
    "",
  ];
  return lines.join("\n");
}

export function writeOutputs(model, outDir, meta) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = {
    "archmap.json": stableJson({ meta, ...model }),
    "invariants.json": stableJson(model.invariants),
    "env-matrix.json": stableJson(model.env),
    "routes-matrix.json": stableJson(model.routes),
    "stale-systems.json": stableJson(model.staleOrDuplicateSystems),
    "packages.mmd": renderPackageGraph(model) + "\n",
    "runtime.mmd": renderRuntimeGraph(model) + "\n",
    "critical-paths.mmd": renderCriticalPaths(model) + "\n",
    "workflows.mmd": renderWorkflowGraph(model) + "\n",
    "ARCHITECTURE.md": renderReport(model, meta),
  };
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(outDir, name), content);
  return Object.keys(files).map((f) => path.join(outDir, f));
}

function heap() {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const outDir = path.resolve(REPO_ROOT, args.out ?? path.join("artifacts", "archmap", stamp));
  const meta = {
    generatedAt: new Date().toISOString(),
    gitSha: git(["rev-parse", "HEAD"]),
    gitDirty: (git(["status", "--porcelain"]) ?? "") !== "",
    node: process.version,
    command: `node tools/archmap/archmap.mjs ${argv.join(" ")}`.trim(),
    repeat: args.repeat,
    probe: args.probe ? path.relative(REPO_ROOT, path.resolve(args.probe)) : null,
    iterations: [],
  };
  const probe = args.probe ? readJson(path.resolve(args.probe)) : null;
  let model = null;
  let firstJson = null;
  for (let i = 0; i < args.repeat; i++) {
    const t0 = process.hrtime.bigint();
    const m = buildModel(REPO_ROOT, probe);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const json = JSON.stringify(m);
    const identical = firstJson === null ? true : json === firstJson;
    if (firstJson === null) firstJson = json;
    meta.iterations.push({
      i,
      ms: Math.round(ms),
      heap: heap(),
      bytes: json.length,
      identicalToFirst: identical,
    });
    model = m;
  }
  meta.deterministic = meta.iterations.every((it) => it.identicalToFirst);
  const written = writeOutputs(model, outDir, meta);
  const s = model.summary;
  if (!args.quiet) {
    process.stderr.write(
      [
        `archmap @ ${meta.gitSha} → ${path.relative(REPO_ROOT, outDir)}`,
        `packages=${s.packages} swiftTargets=${s.swiftTargets} edgeRoutes=${s.edgeRoutes} legacyRoutes=${s.legacyRoutes} env=${s.envVars} flags=${s.featureFlags} workflows=${s.workflows} migrations=${s.supabaseMigrations}+${s.legacyMigrations}`,
        `invariants: ${s.invariants.pass} pass / ${s.invariants.fail} fail / ${s.invariants.info} info${s.invariants.fail ? ` — failing: ${s.invariants.failing.join(", ")}` : ""}`,
        `deterministic=${meta.deterministic} iterations=${meta.iterations.map((it) => `${it.ms}ms/${Math.round(it.heap.heapUsed / 1e6)}MB`).join(",")}`,
        `wrote ${written.length} files`,
        "",
      ].join("\n"),
    );
  }
  if (!meta.deterministic) return 3;
  if (args.check && s.invariants.fail > 0) return 1;
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
